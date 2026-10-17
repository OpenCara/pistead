import XCTest

/// End-to-end flows against a test-mode Pistead server with a faux host (`pnpm dev:native`), driving an installed
/// development build. Configuration comes from run.sh through TEST_RUNNER_-prefixed environment variables.
final class PisteadUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "com.pistead.app")
  private let env = ProcessInfo.processInfo.environment
  private var shots: URL? { env["PISTEAD_SHOTS"].map { URL(fileURLWithPath: $0, isDirectory: true) } }

  override func setUp() {
    continueAfterFailure = false
  }

  private func setting(_ name: String) -> String {
    guard let value = env[name], !value.isEmpty else { fatalError("\(name) is not set; run the tests through run.sh") }
    return value
  }

  private func element(_ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  @discardableResult
  private func wait(_ element: XCUIElement, _ timeout: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    XCTAssertTrue(element.waitForExistence(timeout: timeout), "Timed out waiting for \(element)", file: file, line: line)
    return element
  }

  private func shot(_ name: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    if let shots {
      try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
      try? png.write(to: shots.appendingPathComponent("\(name).png"))
    }
  }

  private func launch() {
    app.terminate()
    app.launch()
  }

  /// Signs out if a previous run left the app signed in, then signs in with the developer token.
  private func signIn() {
    let settings = element("open-settings")
    let github = element("github-sign-in")
    let deadline = Date().addingTimeInterval(30)
    while !settings.exists && !github.exists && Date() < deadline { _ = settings.waitForExistence(timeout: 1) }
    if settings.exists {
      settings.tap()
      wait(element("sign-out")).tap()
      wait(app.alerts.buttons["Sign out"]).tap()
    }
    wait(github)
    shot("01-sign-in")
    if element("server-change").exists { element("server-change").tap() }
    let server = wait(element("server-input"))
    server.tap()
    server.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 60) + setting("PISTEAD_SERVER"))
    element("developer-toggle").tap()
    let token = wait(element("developer-token"))
    token.tap()
    token.typeText(setting("PISTEAD_TOKEN"))
    shot("02-developer-sign-in")
    element("developer-sign-in").tap()
    wait(element("open-settings"), 30)
  }

  private func text(containing value: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
  }

  private func waitGone(_ element: XCUIElement, _ timeout: TimeInterval = 60) {
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
    waitForExpectations(timeout: timeout)
  }

  func test1SignInSendApprove() {
    launch()
    signIn()
    let sessionId = setting("PISTEAD_SESSION_ID")
    let row = wait(element("session-row-\(sessionId)"))
    // Each row shows the session's status, here what its agent last did.
    let statuses = ["In progress", "Needs approval", "Failed", "Done", "Idle"]
    XCTAssertTrue(statuses.contains { row.label.contains($0) }, "Session row has no status: \(row.label)")
    shot("03-sessions")
    row.tap()
    wait(app.staticTexts["Live"], 30)
    shot("04-session")

    // A unique command, so the result checked below is this run's.
    let marker = "hi-\(UUID().uuidString.prefix(8).lowercased())"
    let input = wait(element("composer-input"))
    input.tap()
    input.typeText("TEST_BASH echo \(marker)")
    element("composer-send").tap()

    // The faux model asks to run the command: a pending bash approval with Approve/Deny and who it runs as.
    let approve = wait(element("approval-approve"), 60)
    // The pinned card scrolls into view on its own.
    expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: approve)
    waitForExpectations(timeout: 10)
    let hint = wait(element("approval-hint"))
    XCTAssertTrue(hint.label.hasPrefix("Runs as "), "Approval hint was: \(hint.label)")
    XCTAssertTrue(hint.label.contains("each approval covers one exact operation and its arguments"), "Approval hint was: \(hint.label)")
    shot("05-pending-approval")
    approve.tap()

    // Approve decides at once: no confirmation dialog, and the decided card leaves the chat box. An interrupted earlier
    // run can leave its own card pending; those are approved too.
    XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 1), "Approve asked for confirmation")
    let deadline = Date().addingTimeInterval(60)
    while element("approval-approve").exists && Date() < deadline {
      let next = element("approval-approve")
      if !next.isHittable { app.swipeDown() } else if next.isEnabled { next.tap() }
      _ = app.alerts.firstMatch.waitForExistence(timeout: 2)
      XCTAssertFalse(app.alerts.firstMatch.exists, "Approve asked for confirmation")
    }
    waitGone(element("approval-approve"), 5)
    shot("06-after-approval")
    element("session-approvals").tap()
    wait(text(containing: "Requested by"))
    let result = wait(app.staticTexts.matching(NSPredicate(format: "identifier == 'approval-result' AND label CONTAINS %@", marker)).firstMatch, 60)
    XCTAssertTrue(result.exists)
    shot("07-approvals")
  }

  func test2NewSession() {
    launch()
    if !element("open-settings").waitForExistence(timeout: 30) { signIn() }
    element("new-session").tap()
    let message = wait(element("new-message"))
    let start = wait(element("new-start"))
    let enabled = NSPredicate(format: "isEnabled == true")
    expectation(for: enabled, evaluatedWith: start)
    waitForExpectations(timeout: 30)
    message.tap()
    message.typeText("TEST_IDENTITY")
    // The keyboard may cover Start on a phone; tapping outside the message dismisses it.
    app.staticTexts["What should we work on?"].firstMatch.tap()
    expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: start)
    waitForExpectations(timeout: 10)
    shot("08-new-session")
    start.tap()
    // The new session opens with its first message, which runs: the faux model answers with the tool's result.
    wait(app.staticTexts["TEST_IDENTITY"], 90)
    wait(app.staticTexts["Live"], 60)
    wait(text(containing: "Deterministic test provider result"), 90)
    shot("09-new-session-ran")
  }
}
