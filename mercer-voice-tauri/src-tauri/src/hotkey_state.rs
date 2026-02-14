use std::sync::Mutex;

/// Stores the frontmost app's bundle id when hotkey is pressed, so we can paste into it on release.
pub struct HotkeyState {
    pub paste_target_bundle_id: Mutex<Option<String>>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            paste_target_bundle_id: Mutex::new(None),
        }
    }
}

impl HotkeyState {
    pub fn set_paste_target(&self, bundle_id: Option<String>) {
        *self.paste_target_bundle_id.lock().unwrap() = bundle_id;
    }

    pub fn take_paste_target(&self) -> Option<String> {
        self.paste_target_bundle_id.lock().unwrap().take()
    }
}
