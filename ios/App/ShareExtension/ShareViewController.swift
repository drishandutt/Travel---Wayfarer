import UIKit
import UniformTypeIdentifiers

// "Share → Wayfarer" from Instagram, YouTube, X, LinkedIn, Safari, Maps or anywhere else.
// The link (and any words shared with it) goes to the app as wayfarer://share?url=…&text=…;
// the app reads it for places and asks which trip they go in. Nothing is kept here.
class ShareViewController: UIViewController {
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.114, green: 0.114, blue: 0.122, alpha: 1)
        label.text = "Opening Wayfarer…"
        label.textColor = .white
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await handOver() }
    }

    private func handOver() async {
        let (url, text) = await sharedLink()
        guard let link = url else {
            show("There’s no link in that. Share a post, video, page or map instead.")
            return
        }
        var parts = URLComponents()
        parts.scheme = "wayfarer"
        parts.host = "share"
        parts.queryItems = [URLQueryItem(name: "url", value: link)] + (text.map { [URLQueryItem(name: "text", value: String($0.prefix(1000)))] } ?? [])
        guard let target = parts.url else { return finish() }
        if openApp(target) {
            finish()
        } else {
            // the app couldn't be opened from here: leave the link on the clipboard instead
            UIPasteboard.general.string = link
            show("The link is copied. Open Wayfarer and paste it into the chat.")
        }
    }

    // A shared URL, or the first link in shared text ("Look at this! https://…").
    private func sharedLink() async -> (String?, String?) {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var words: String?
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, url.scheme?.hasPrefix("http") == true {
                for t in providers where t.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let s = try? await t.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String, s != url.absoluteString { words = s }
                }
                return (url.absoluteString, words)
            }
        }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
                if let m = detector?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let url = m.url {
                    let rest = s.replacingOccurrences(of: (s as NSString).substring(with: m.range), with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                    return (url.absoluteString, rest.isEmpty ? nil : rest)
                }
            }
        }
        return (nil, nil)
    }

    // Extensions can't call UIApplication.shared, but the app object is in the responder chain;
    // its open(_:options:completionHandler:) is reached through the Objective-C runtime.
    private func openApp(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: selector), r.isKind(of: NSClassFromString("UIApplication")!) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                let open = unsafeBitCast(r.method(for: selector), to: Open.self)
                open(r, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = r.next
        }
        return false
    }

    @MainActor private func show(_ message: String) {
        label.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.finish() }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
