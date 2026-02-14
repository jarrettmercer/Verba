#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;

    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;

        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const i8,
            encoding: u32,
        ) -> *const c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    pub fn check_and_request_permissions() {
        // ── Input Monitoring ────────────────────────────────────────
        let has_listen = unsafe { CGPreflightListenEventAccess() };
        if has_listen {
            eprintln!("[Verba] Input Monitoring permission: granted");
        } else {
            eprintln!("[Verba] Input Monitoring not granted — requesting…");
            unsafe {
                CGRequestListenEventAccess();
            }
        }

        // ── Accessibility ───────────────────────────────────────────
        unsafe {
            let key_cstr = b"AXTrustedCheckOptionPrompt\0";
            let key = CFStringCreateWithCString(
                ptr::null(),
                key_cstr.as_ptr() as *const i8,
                CF_STRING_ENCODING_UTF8,
            );
            let keys = [key];
            let values = [kCFBooleanTrue];
            let dict = CFDictionaryCreate(
                ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const u8 as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const u8 as *const c_void,
            );

            let trusted = AXIsProcessTrustedWithOptions(dict);
            if trusted {
                eprintln!("[Verba] Accessibility permission: granted");
            } else {
                eprintln!("[Verba] Accessibility not granted — system prompt shown");
            }

            CFRelease(dict);
            CFRelease(key);
        }
    }
}

#[cfg(target_os = "macos")]
pub fn check_and_request_permissions() {
    macos::check_and_request_permissions();
}

#[cfg(not(target_os = "macos"))]
pub fn check_and_request_permissions() {
    // No special permissions needed on Windows/Linux
}
