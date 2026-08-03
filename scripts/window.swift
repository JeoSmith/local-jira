// The window, as an actual application.
//
// The first launcher opened a Chromium window in `--app` mode. It looked right
// until you ran it: the Dock said "Google Chrome", with Chrome's icon, and
// ⌘Tab agreed. It was a shortcut that opened a browser, not an app.
//
// This is a real one — its own Dock entry, its own icon, its own menu bar —
// built on `WKWebView`, which ships with macOS. No Electron, no Tauri, nothing
// downloaded: the dependency count stays at zero (S2-D1, S6-D6).
//
// Values come from the environment so one binary serves every board the
// builder makes.

import Cocoa
import WebKit

let environment = ProcessInfo.processInfo.environment
let port = environment["LJ_PORT"] ?? "4173"
let boardRepo = environment["LJ_REPO"] ?? ""
let cliPath = environment["LJ_CLI"] ?? ""
let nodePath = environment["LJ_NODE"] ?? "/usr/local/bin/node"
let boardURL = URL(string: "http://127.0.0.1:\(port)/")!

/// The server, when this app is the one that started it.
///
/// Somebody running `localjira serve` in a terminal must not lose it because
/// they closed a window they opened afterwards — so a server that was already
/// answering is left alone, and only a child of this process is stopped on quit.
final class Server {
    private var process: Process?

    func startIfNeeded() {
        guard !isAnswering(), !boardRepo.isEmpty, !cliPath.isEmpty else { return }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodePath)
        task.arguments = [cliPath, "serve", "--port", port]
        task.currentDirectoryURL = URL(fileURLWithPath: boardRepo)
        let log = FileHandle(forWritingAtPath: "/tmp/local-jira-app.log")
            ?? FileHandle.nullDevice
        task.standardOutput = log
        task.standardError = log
        try? task.run()
        process = task
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    /// A HEAD against the board. Short timeout: this runs while the window waits.
    func isAnswering() -> Bool {
        var request = URLRequest(url: boardURL)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 1

        let waiter = DispatchSemaphore(value: 0)
        var reachable = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            reachable = (response as? HTTPURLResponse) != nil
            waiter.signal()
        }.resume()
        _ = waiter.wait(timeout: .now() + 2)
        return reachable
    }
}

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private let server = Server()
    private var attempts = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        server.startIfNeeded()

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Local Jira"
        window.setFrameAutosaveName("LocalJiraWindow")
        window.center()

        web = WKWebView(frame: window.contentView!.bounds)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.contentView!.addSubview(web)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        web.load(URLRequest(url: boardURL))
    }

    // The server takes a moment to come up, so a first load can fail on a
    // perfectly good board. Retry for a while, then say so rather than leaving
    // a blank window with no explanation.
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retry()
    }

    func webView(
        _ view: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        retry()
    }

    private func retry() {
        attempts += 1
        guard attempts < 40 else {
            return explain()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.web.load(URLRequest(url: boardURL))
        }
    }

    private func explain() {
        let alert = NSAlert()
        alert.messageText = "보드를 열지 못했습니다"
        alert.informativeText =
            "\(boardURL.absoluteString) 에 연결하지 못했습니다.\n"
            + "포트가 이미 쓰이고 있거나 보드에 문제가 있을 수 있습니다.\n"
            + "자세한 내용은 /tmp/local-jira-app.log 를 보세요."
        alert.alertStyle = .warning
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ note: Notification) {
        server.stop()
    }

    /// A menu bar, because without one ⌘C, ⌘V and ⌘Q do nothing.
    ///
    /// A web view gets its copy and paste from the Edit menu's responder
    /// actions; an app with no menu looks finished until somebody tries to copy
    /// an issue key out of it.
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Local Jira 정보", action: nil, keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Local Jira 종료",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "편집")
        for (title, selector, key) in [
            ("실행 취소", #selector(UndoManager.undo), "z"),
            ("잘라내기", #selector(NSText.cut(_:)), "x"),
            ("복사", #selector(NSText.copy(_:)), "c"),
            ("붙여넣기", #selector(NSText.paste(_:)), "v"),
            ("전체 선택", #selector(NSText.selectAll(_:)), "a"),
        ] as [(String, Selector, String)] {
            edit.addItem(withTitle: title, action: selector, keyEquivalent: key)
        }
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "보기")
        view.addItem(withTitle: "새로 고침", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reload() {
        web.reload()
    }
}

let application = NSApplication.shared
let delegate = Delegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
