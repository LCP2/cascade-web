import Capacitor

/// CAS-932: the default CAPBridgeViewController has no hook for registering an in-app (not npm-vendored)
/// plugin — that needs a subclass overriding capacitorDidLoad(). Every plugin used before this one shipped
/// as an installed npm package instead, so nothing in this project needed one until now.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactPicker())
    }
}
