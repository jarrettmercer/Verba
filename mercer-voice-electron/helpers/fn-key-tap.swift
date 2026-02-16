import Cocoa

// Fn/Globe key constants (same as Tauri's hotkey.rs)
let KVK_FUNCTION: Int64 = 0x3F
let FN_FLAG_MASK: UInt64 = 0x0080_0000

var fnDown = false

func tapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let refcon = refcon {
            let tap = Unmanaged<CFMachPort>.fromOpaque(refcon).takeUnretainedValue()
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passRetained(event)
    }

    guard type == .flagsChanged else {
        return Unmanaged.passRetained(event)
    }

    let keycode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keycode == KVK_FUNCTION else {
        return Unmanaged.passRetained(event)
    }

    let flags = event.flags.rawValue
    let isFnDown = (flags & FN_FLAG_MASK) != 0

    if isFnDown && !fnDown {
        fnDown = true
        print("PRESS")
        fflush(stdout)
    } else if !isFnDown && fnDown {
        fnDown = false
        print("RELEASE")
        fflush(stdout)
    }

    return Unmanaged.passRetained(event)
}

let eventMask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: eventMask,
    callback: tapCallback,
    userInfo: nil
) else {
    fputs("ERROR: Could not create event tap. Grant Accessibility permission.\n", stderr)
    exit(1)
}

// Store tap pointer so we can re-enable on timeout
let tapOpaque = Unmanaged.passUnretained(tap).toOpaque()

// Create a new tap with userInfo for re-enable support
// Since CGEvent.tapCreate doesn't let us update userInfo, we store it globally
guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    fputs("ERROR: Could not create run loop source.\n", stderr)
    exit(1)
}

CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

fputs("READY\n", stderr)
CFRunLoopRun()
