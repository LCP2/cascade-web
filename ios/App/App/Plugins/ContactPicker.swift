import Foundation
import Capacitor
import ContactsUI

/// CAS-932: a single-contact picker with no contacts permission of any kind.
///
/// CNContactPickerViewController runs out of process — the OS shows only the contact the person taps,
/// and the app receives just that one. That is why this deliberately never touches CNContactStore:
/// no `authorizationStatus(for:)` check, no `requestAccess(for:)` call, no NSContactsUsageDescription key.
/// Adding any of those would defeat the point of using the picker at all (see the ticket's Context section,
/// and capacitor-contact-picker.js's header comment for the two published plugins that were checked and
/// rejected for doing exactly that).
@objc(ContactPicker)
public class ContactPicker: CAPPlugin, CAPBridgedPlugin, CNContactPickerDelegate {
    public let identifier = "ContactPicker"
    public let jsName = "ContactPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickContact", returnType: CAPPluginReturnPromise)
    ]

    /// The call awaiting the picker's result — only one pick can be in flight at a time.
    private var pickCall: CAPPluginCall?

    @objc func pickContact(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pickCall == nil else {
                call.reject("A contact pick is already in progress")
                return
            }
            guard let viewController = self.bridge?.viewController else {
                call.reject("No view controller to present the picker from")
                return
            }
            self.pickCall = call
            let picker = CNContactPickerViewController()
            picker.delegate = self
            // Present from the top-most controller so an already-presented sheet doesn't make
            // present() fail silently and strand the call.
            var presenter = viewController
            while let presented = presenter.presentedViewController {
                presenter = presented
            }
            presenter.present(picker, animated: true)
        }
    }

    public func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        picker.dismiss(animated: true, completion: nil)
        let name = [contact.givenName, contact.familyName]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let emails = contact.emailAddresses.map { String($0.value) }
        let phones = contact.phoneNumbers.map { $0.value.stringValue }
        pickCall?.resolve([
            "name": name,
            "emails": emails,
            "phones": phones
        ])
        pickCall = nil
    }

    public func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        picker.dismiss(animated: true, completion: nil)
        pickCall?.resolve(["cancelled": true])
        pickCall = nil
    }
}
