#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

/*
 * WeChat IME voice input is configured for LEFT Option + Space. Synthesized
 * events must therefore carry the device-dependent LEFT-option flag
 * (NX_DEVICELALTKEYMASK = 0x20) in addition to the abstract alternate mask
 * (kCGEventFlagMaskAlternate = 0x80000); otherwise the IME treats the
 * modifier as an unspecified/right Option and ignores the hotkey.
 */
#define NX_DEVICELALTKEYMASK 0x00000020
#define ALT_FLAGS (NX_DEVICELALTKEYMASK | kCGEventFlagMaskAlternate)

/*
 * PTT helper: mimics a physical push-to-talk key sequence at the HID event tap,
 * exactly like the user's manual action (hold Option, tap Space, release):
 *   1. Option key down
 *   2. wait 200ms (Option held)
 *   3. Space key down / up (with the Option modifier)
 *   4. wait, then Option key up
 *
 * Posting at kCGHIDEventTap makes the events look like hardware input, which
 * is what global-hotkey listeners (RegisterEventHotKey) expect.
 */
int main(void) {
	// Preflight: if the posting process lacks Accessibility permission, exit 3
	// so the plugin logs a clear error instead of silently doing nothing.
	if (CGPreflightPostEventAccess() == false) {
		return 3;
	}

	CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
	if (!src) {
		return 2;
	}

	CGEventRef optDown = CGEventCreateKeyboardEvent(src, 58, true); /* kVK_Option */
	CGEventSetFlags(optDown, ALT_FLAGS);
	CGEventPost(kCGHIDEventTap, optDown);
	CFRelease(optDown);

	usleep(200000);

	CGEventRef spDown = CGEventCreateKeyboardEvent(src, 49, true); /* kVK_Space */
	CGEventSetFlags(spDown, ALT_FLAGS);
	CGEventPost(kCGHIDEventTap, spDown);
	CFRelease(spDown);

	usleep(60000);

	CGEventRef spUp = CGEventCreateKeyboardEvent(src, 49, false);
	CGEventSetFlags(spUp, ALT_FLAGS);
	CGEventPost(kCGHIDEventTap, spUp);
	CFRelease(spUp);

	usleep(40000);

	CGEventRef optUp = CGEventCreateKeyboardEvent(src, 58, false);
	CGEventSetFlags(optUp, ALT_FLAGS);
	CGEventPost(kCGHIDEventTap, optUp);
	CFRelease(optUp);
	CFRelease(src);
	return 0;
}
