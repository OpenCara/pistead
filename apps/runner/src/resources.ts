import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/**
 * Operator-provisioned resources, never a request/model-controlled configuration.
 * cgroupRoot: exclusive delegated v2 subtree with cpu/memory/pids enabled, no tasks.
 * controlRoot: private runner-owned directory, outside session/runtime mounts.
 * Each sandbox root must be an exclusive ext4 or tmpfs mount, not a subdirectory
 * or bind alias. Its TOTAL blocks and inodes must fit the configured ceilings.
 * ext4 supports durable sessions; tmpfs does not survive host reboot. Provisioning,
 * mounting, restore-to-volume and volume removal remain operator responsibilities.
 * The runner must be non-root, in an unlimited leaf beside cgroupRoot beneath the
 * SAME enclosing budget. No ancestor controls, mounts or unrelated tasks are changed.
 */
export interface ResourceConfig {
  cgroupRoot: string;
  controlRoot: string;
  cpuQuotaMicros: number;
  cpuPeriodMicros: number;
  memoryMaxBytes: number;
  pidsMax: number;
  writableMaxBytes: number;
  writableMaxInodes: number;
}

export interface ResourceAvailability {
  available: boolean;
  reason?: string;
}

export function validateResourceConfig(config: ResourceConfig): Readonly<ResourceConfig> {
  if (!config || typeof config !== "object") throw new Error("Production bash requires provisioned ResourceConfig");
  for (const field of ["cgroupRoot", "controlRoot"] as const) {
    const value = config[field];
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/" || /[\0\r\n]/.test(value)) {
      throw new Error(`Invalid resource ${field}`);
    }
    if (["/usr", "/lib", "/lib64"].some((path) => value === path || value.startsWith(`${path}/`))) {
      throw new Error("Resource control directories cannot be exposed runtime mounts");
    }
  }
  for (const field of ["cpuQuotaMicros", "cpuPeriodMicros", "memoryMaxBytes", "pidsMax", "writableMaxBytes", "writableMaxInodes"] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) throw new Error(`Invalid resource ${field}`);
  }
  if (config.cpuPeriodMicros < 1_000 || config.cpuPeriodMicros > 1_000_000 || config.cpuQuotaMicros < 1_000) {
    throw new Error("CPU quota/period are outside cgroup v2 bounds");
  }
  return Object.freeze({ ...config });
}

/* This is a trusted, isolated Python supervisor, not the untrusted command. It
 * stays outside the child cgroup so memory.max/pids.max cannot prevent cleanup.
 * Child exec is pipe-gated until the kernel confirms membership. The supervisor
 * holds a flock through kill+empty verification; SIGKILL recovery takes that same
 * lock before killing only named domains with our private ownership marker.
 */
const SUPERVISOR = String.raw`
import fcntl, json, os, re, select, signal, stat, sys, time

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_NOFOLLOW | os.O_CLOEXEC
PREFIX = 'session-'
KEY = re.compile(r'^session-[0-9a-f]{64}$')
config = json.loads(sys.argv[1])
mode = sys.argv[2]
stopped = False


def stop(signum, frame):
    global stopped
    stopped = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def directory(path, private=False):
    require(os.path.isabs(path) and os.path.normpath(path) == path and path != '/', 'invalid resource directory')
    fd = os.open('/', DIR)
    try:
        for part in path.split('/')[1:]:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            require(info.st_uid in (0, os.getuid()), 'untrusted resource ancestor owner')
            require(not info.st_mode & 0o022 or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX), 'untrusted writable resource ancestor')
        info = os.fstat(fd)
        require(info.st_uid == os.getuid(), 'resource directory must be runner-owned')
        if private:
            require(not info.st_mode & 0o077, 'resource directory must be private')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_at(fd, name):
    child = os.open(name, os.O_RDONLY | FILE, dir_fd=fd)
    try:
        return os.read(child, 65536).decode().strip()
    finally:
        os.close(child)


def write_at(fd, name, value):
    child = os.open(name, os.O_WRONLY | FILE, dir_fd=fd)
    try:
        data = (str(value) + '\n').encode()
        require(os.write(child, data) == len(data), 'short cgroup control write')
    finally:
        os.close(child)


def mounts():
    result = []
    def unescape(value):
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), value)
    with open('/proc/self/mountinfo') as stream:
        for line in stream:
            left, right = line.rstrip().split(' - ', 1)
            a, b = left.split(), right.split()
            result.append(dict(id=a[0], device=a[2], root=unescape(a[3]), path=unescape(a[4]), options=set(a[5].split(',')), kind=b[0]))
    return result


def mount_for(fd, entries):
    with open('/proc/self/fdinfo/' + str(fd)) as stream:
        ids = [line.split()[1] for line in stream if line.startswith('mnt_id:')]
    require(len(ids) == 1, 'cannot identify pinned mount')
    found = [entry for entry in entries if entry['id'] == ids[0]]
    require(len(found) == 1, 'pinned mount is not visible')
    return found[0]


def beneath(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def verify_host():
    require(sys.platform == 'linux' and os.getuid() != 0 and os.geteuid() == os.getuid(), 'resource execution requires an unprivileged Linux runner')
    entries = mounts()
    cg = directory(config['cgroupRoot'])
    control = directory(config['controlRoot'], True)
    mount = mount_for(cg, entries)
    require(mount['kind'] == 'cgroup2' and mount['root'] == '/', 'a visible unified cgroup v2 hierarchy is required')
    require('rw' in mount['options'], 'cgroup delegation is read-only')
    require(os.access(config['cgroupRoot'], os.W_OK) and os.access(config['controlRoot'], os.W_OK), 'resource delegation/control directory is not writable')
    require(read_at(cg, 'cgroup.type') == 'domain', 'threaded resource domains are unsupported')
    require(not read_at(cg, 'cgroup.procs'), 'delegated resource root must contain no tasks')
    enabled = set(read_at(cg, 'cgroup.subtree_control').split())
    require({'cpu', 'memory', 'pids'} <= enabled, 'operator must delegate and enable cpu, memory, pids')
    with open('/proc/self/cgroup') as stream:
        current = [line.strip()[3:] for line in stream if line.startswith('0::')]
    require(len(current) == 1 and current[0].startswith('/') and '..' not in current[0].split('/'), 'cannot identify enclosing cgroup budget')
    current_path = os.path.normpath(mount['path'] + current[0])
    parent = os.path.dirname(current_path)
    require(current_path != mount['path'] and beneath(config['cgroupRoot'], parent) and not beneath(config['cgroupRoot'], current_path), 'delegation must stay beneath the runner leaf parent budget')
    # Moving our freshly forked child may skip ONLY this unlimited runner leaf.
    leaf = os.open(current_path, DIR)
    try:
        require(read_at(leaf, 'cpu.max').split()[0] == 'max', 'would bypass runner leaf CPU budget')
        for name in ('memory.max', 'memory.high', 'memory.swap.max', 'pids.max'):
            require(read_at(leaf, name) == 'max', 'would bypass runner leaf ' + name)
    finally:
        os.close(leaf)
    require(not beneath(config['controlRoot'], config['cgroupRoot']) and not beneath(config['cgroupRoot'], config['controlRoot']), 'control and cgroup roots must be separate')
    return cg, control, entries


def verify_storage(root, entries):
    info = os.fstat(root)
    require(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'session volume must be private and runner-owned')
    path = os.readlink('/proc/self/fd/' + str(root))
    mount = mount_for(root, entries)
    require(mount['path'] == path and mount['root'] == '/', 'session root must be a dedicated filesystem mount, not a directory or bind subdirectory')
    require(mount['kind'] in ('tmpfs', 'ext4'), 'only bounded tmpfs or persistent ext4 session volumes are supported')
    require({'rw', 'nosuid', 'nodev'} <= mount['options'], 'session volume requires rw,nosuid,nodev')
    require(len([item for item in entries if item['device'] == mount['device']]) == 1, 'session filesystem has shared/bind mount aliases')
    require(not any(item['path'] != path and beneath(item['path'], path) for item in entries), 'nested session mounts are forbidden')
    require(not beneath(config['controlRoot'], path) and not beneath(config['cgroupRoot'], path), 'resource controls cannot be exposed in the session')
    fs = os.fstatvfs(root)
    require(0 < fs.f_blocks * fs.f_frsize <= config['writableMaxBytes'], 'session filesystem total capacity exceeds writableMaxBytes')
    require(0 < fs.f_files <= config['writableMaxInodes'], 'session filesystem total inode capacity exceeds writableMaxInodes')
    return mount


def lock(cg, control, name, create=False):
    flags = os.O_RDWR | os.O_NONBLOCK | FILE
    created = False
    if create:
        try:
            fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=control)
            created = True
        except FileExistsError:
            fd = os.open(name, flags, dir_fd=control)
    else:
        fd = os.open(name, flags, dir_fd=control)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and not info.st_mode & 0o077, 'unsafe resource ownership marker')
        deadline = time.monotonic() + 6
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not create:
                    raise
                require(not stopped and time.monotonic() < deadline, 'resource domain busy or launch cancelled')
                time.sleep(0.02)
        with open('/proc/sys/kernel/random/boot_id') as stream:
            boot = stream.read().strip()
        root_info = os.fstat(cg)
        record = {'root': config['cgroupRoot'], 'device': root_info.st_dev, 'inode': root_info.st_ino, 'boot': boot, 'name': name}
        try:
            previous = json.loads(os.read(fd, 4096))
        except (ValueError, UnicodeError):
            previous = None
        if previous != record:
            require(previous is None or (isinstance(previous, dict) and previous.get('root') == config['cgroupRoot'] and previous.get('name') == name), 'resource ownership marker does not match delegated root')
            # Interrupted marker writes and recreated delegated roots may be
            # repaired ONLY when no group exists. Never adopt unknown host tasks.
            try:
                os.stat(name, dir_fd=cg, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise RuntimeError('refusing to adopt an unowned resource domain')
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            data = json.dumps(record).encode()
            require(os.write(fd, data) == len(data), 'short ownership marker write')
            os.fsync(fd)
            os.fsync(control)
        return fd
    except BaseException:
        os.close(fd)
        raise


def kill_empty(group):
    write_at(group, 'cgroup.kill', 1)
    deadline = time.monotonic() + 5
    while 'populated 1' in read_at(group, 'cgroup.events').splitlines():
        require(time.monotonic() < deadline, 'resource descendants failed to exit; domain remains quarantined')
        time.sleep(0.01)


def recover(cg, control):
    # Never inspect/migrate arbitrary host tasks. Private markers and the dedicated
    # namespace are both required. A live supervisor retains its exclusive lock.
    failures = []
    for name in os.listdir(control):
        if not KEY.fullmatch(name):
            continue
        try:
            marker = lock(cg, control, name)
        except BlockingIOError:
            continue
        except Exception as error:
            failures.append(name + ': ' + str(error))
            continue
        try:
            try:
                group = os.open(name, DIR, dir_fd=cg)
            except FileNotFoundError:
                continue
            try:
                kill_empty(group)
            finally:
                os.close(group)
        except Exception as error:
            failures.append(name + ': ' + str(error))
        finally:
            os.close(marker)
    require(not failures, 'quarantined resource domains: ' + '; '.join(failures)[:2048])


def run(cg, control, entries):
    name = PREFIX + sys.argv[3]
    require(KEY.fullmatch(name), 'invalid resource session key')
    # The command's time limit, from the host's configuration: the runner's own deadline is the same.
    require(re.fullmatch(r'[1-9][0-9]{0,4}', sys.argv[4]) is not None and int(sys.argv[4]) <= 86400, 'invalid resource deadline')
    seconds = int(sys.argv[4])
    verify_storage(8, entries)
    for fd in (3, 4, 5):
        require(os.fstat(fd).st_dev == os.fstat(8).st_dev and mount_for(fd, entries)['id'] == mount_for(8, entries)['id'], 'writable mount escapes bounded session volume')
    marker = lock(cg, control, name, True)
    require(not stopped, 'resource launch cancelled')
    group = None
    child = None
    gate = None
    # Keep the per-session cgroup after exit: cached file pages remain charged to
    # this session instead of being reparented by rmdir between shell commands.
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=cg)
        except FileExistsError:
            pass
        group = os.open(name, DIR, dir_fd=cg)
        kill_empty(group)
        require(read_at(group, 'cgroup.type') == 'domain', 'session cgroup is not a domain')
        page = os.sysconf('SC_PAGE_SIZE')
        memory_max = config['memoryMaxBytes'] // page * page
        require(memory_max > 0, 'memoryMaxBytes is smaller than a kernel page')
        values = {'cpu.max': str(config['cpuQuotaMicros']) + ' ' + str(config['cpuPeriodMicros']),
                  'memory.max': memory_max, 'memory.swap.max': 0,
                  'memory.oom.group': 1, 'pids.max': config['pidsMax']}
        for file, value in values.items():
            write_at(group, file, value)
            require(read_at(group, file) == str(value), 'kernel did not apply ' + file)
        deadline = time.monotonic() + seconds
        gate_read, gate = os.pipe2(os.O_CLOEXEC)
        child = os.fork()
        if child == 0:
            try:
                os.close(gate)
                # On supervisor SIGKILL, gate EOF prevents any uncharged exec.
                if os.read(gate_read, 1) != b'1':
                    os._exit(125)
                for fd in list(map(int, os.listdir('/proc/self/fd'))):
                    if fd > 6:
                        try:
                            os.close(fd)
                        except OSError:
                            pass
                os.execve('/usr/bin/bwrap', ['/usr/bin/bwrap'] + sys.argv[5:], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
            except BaseException:
                os._exit(125)
        os.close(gate_read)
        # Only this new, gated child is moved. Its descendants inherit membership.
        write_at(group, 'cgroup.procs', child)
        require(str(child) in read_at(group, 'cgroup.procs').splitlines(), 'child cgroup membership not confirmed')
        require(not stopped, 'resource launch cancelled')
        os.write(gate, b'1')
        os.close(gate)
        gate = None
        while True:
            exited, status = os.waitpid(child, os.WNOHANG)
            if exited:
                child = None
                return os.waitstatus_to_exitcode(status)
            require(not stopped, 'resource execution cancelled')
            require(time.monotonic() < deadline, 'resource wall deadline exceeded')
            readable, _, _ = select.select([7], [], [], 0.02)
            if readable:
                require(os.read(7, 1), 'runner exited; killing resource descendants')
    finally:
        if gate is not None:
            os.close(gate)
        try:
            if group is not None:
                kill_empty(group)
            if child is not None:
                # The gated child may not yet have joined the cgroup on failure.
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(child, 0)
        finally:
            if group is not None:
                os.close(group)
            os.close(marker)


try:
    cg, control, entries = verify_host()
    try:
        if mode == 'probe':
            require(len(sys.argv) == 4 and sys.argv[3], 'a provisioned per-session filesystem must be supplied')
            root = directory(sys.argv[3], True)
            try:
                verify_storage(root, entries)
            finally:
                os.close(root)
            print(json.dumps({'available': True}))
        elif mode == 'recover':
            recover(cg, control)
        elif mode == 'run':
            result = run(cg, control, entries)
            sys.exit(result if result >= 0 else 128 - result)
        else:
            raise RuntimeError('unknown resource supervisor mode')
    finally:
        os.close(control)
        os.close(cg)
except Exception as error:
    print('resource boundary unavailable: ' + str(error), file=sys.stderr)
    sys.exit(125)
`;

/** `deadlineSeconds`: the command's time limit; the supervisor kills the whole domain once it passes. */
export function resourceLaunch(config: ResourceConfig, sessionKey: string, args: string[], deadlineSeconds = 30): { command: string; args: string[] } {
  if (!/^[0-9a-f]{64}$/.test(sessionKey)) throw new Error("Invalid resource session key");
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 86_400) throw new Error("Invalid resource deadline");
  return { command: "/usr/bin/python3", args: ["-I", "-c", SUPERVISOR, JSON.stringify(validateResourceConfig(config)), "run", sessionKey, String(deadlineSeconds), ...args] };
}

async function controlCommand(config: ResourceConfig, mode: "probe" | "recover", storageRoot = ""): Promise<void> {
  const checked = validateResourceConfig(config);
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("An unprivileged Linux resource host is required");
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", "-c", SUPERVISOR, JSON.stringify(checked), mode, storageRoot], {
      cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "pipe"],
    });
    let message = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr.on("data", (chunk: Buffer) => { if (message.length < 4096) message += Buffer.from(chunk).toString("utf8").slice(0, 4096 - message.length); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult();
      else reject(new Error(message.trim() || "Resource supervisor unavailable or timed out"));
    });
  });
}

/** Read-only preflight, not authority to execute; every launch verifies again. */
export async function probeResources(config?: ResourceConfig, storageRoot?: string): Promise<ResourceAvailability> {
  if (!config) return { available: false, reason: "Production bash requires explicitly provisioned cgroup and filesystem resources" };
  if (!storageRoot) return { available: false, reason: "A provisioned per-session filesystem must be supplied for verification" };
  try {
    await controlCommand(config, "probe", storageRoot);
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "Resource verification failed" };
  }
}

/** Call on runner startup to reap orphaned OWNED domains; active locks are skipped.
 * Each resource-backed command independently kills its own stale domain before
 * admission; this eager hook also reaps sessions that are not reopened. Corrupt
 * ownership is quarantined, never adopted; recovery reports those failures after
 * attempting the other domains. Callers may keep non-shell APIs available.
 */
export async function recoverResourceOrphans(config: ResourceConfig): Promise<void> {
  await controlCommand(config, "recover");
}
