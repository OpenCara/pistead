import { memberPerson, peopleDirectory, segment, username, type Person, type WorkspaceMember } from "@pistead/client";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useSession } from "./auth";
import { useResource } from "./resource";

/** The people a screen can name by username: a workspace's members and the signed-in user. */
export interface People {
  /** Everyone known. */
  list: Person[];
  /** The person with a user ID. Anyone the list lacks, such as a former member, is known only by their ID. */
  person: (id: string) => Person;
}

function peopleOf(list: Person[]): People {
  return { list, person: peopleDirectory(list) };
}

/** A workspace's members and the signed-in user. Until the members load, only the signed-in user has a username. */
export function useWorkspacePeople(workspaceId: string | null): People {
  const { user } = useSession();
  const members = useResource<{ members: WorkspaceMember[] }>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/members` : null).data?.members;
  return useMemo(() => {
    const list = (members ?? []).map(memberPerson);
    if (!list.some(person => person.id === user.id)) list.push({ id: user.id, githubLogin: user.githubLogin });
    return peopleOf(list);
  }, [members, user.id, user.githubLogin]);
}

const PeopleContext = createContext<People | null>(null);

/** Names the user IDs shown anywhere inside it after `people`. */
export function PeopleProvider({ people, children }: { people: People; children: ReactNode }) {
  return <PeopleContext.Provider value={people}>{children}</PeopleContext.Provider>;
}

/** The surrounding provider's people; without one, only the signed-in user. */
export function usePeople(): People {
  const { user } = useSession();
  const provided = useContext(PeopleContext);
  const own = useMemo(() => peopleOf([{ id: user.id, githubLogin: user.githubLogin }]), [user.id, user.githubLogin]);
  return provided ?? own;
}

/** A user's username, as the web's `<Username>` shows it; `you` names the signed-in user "you". */
export function useUsername(): (id: string, you?: boolean) => string {
  const { user } = useSession();
  const { person } = usePeople();
  return useCallback((id: string, you?: boolean) => you && id === user.id ? "you" : username(person(id)), [person, user.id]);
}
