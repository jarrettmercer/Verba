import Foundation
import CoreGraphics
import ApplicationServices

setbuf(stdout, nil)

// Request Accessibility permission — shows system prompt if not trusted
let opts = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
let trusted = AXIsProcessTrustedWithOptions(opts)
if trusted {
    fputs("info: Accessibility permission granted\n", stderr)
} else {
    fputs("ax-untrusted\n", stderr)
    // Continue anyway — the user may grant permission while we're running,
    // and the tap will start working once granted.
}

var fnDown = false
var globalTap: CFMachPort?

func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = globalTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags.rawValue
    let hasFnFlag = (flags & 0x800000) != 0

    if type == .flagsChanged {
        // kVK_Function = 63 on Intel, may be 179 on some Apple Silicon keyboards
        if keyCode == 63 || keyCode == 179 {
            if hasFnFlag && !fnDown {
                fnDown = true
                print("fn-down")
            } else if !hasFnFlag && fnDown {
                fnDown = false
                print("fn-up")
            }
        }
        // Fallback: detect function-flag toggle regardless of specific keycode
        // (catches keyboards that report a different keycode for Globe)
        else if hasFnFlag && !fnDown {
            fnDown = true
            print("fn-down")
        } else if !hasFnFlag && fnDown {
            fnDown = false
            print("fn-up")
        }
    }

    // Some Apple Silicon keyboards send keyDown/keyUp instead of flagsChanged
    if (type == .keyDown || type == .keyUp) && (keyCode == 63 || keyCode == 179) {
        if type == .keyDown && !fnDown {
            fnDown = true
            print("fn-down")
        } else if type == .keyUp && fnDown {
            fnDown = false
            print("fn-up")
        }
    }

    return Unmanaged.passUnretained(event)
}

// Listen for flagsChanged AND keyDown/keyUp to cover all keyboard behaviors
let eventMask = CGEventMask(
    (1 << CGEventType.flagsChanged.rawValue) |
    (1 << CGEventType.keyDown.rawValue) |
    (1 << CGEventType.keyUp.rawValue)
)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: eventMask,
    callback: eventCallback,
    userInfo: nil
) else {
    fputs("error: Could not create event tap. Grant Accessibility permission in System Settings.\n", stderr)
    exit(1)
}

globalTap = tap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

print("ready")
CFRunLoopRun()
