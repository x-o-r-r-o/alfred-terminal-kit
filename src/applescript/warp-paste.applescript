-- Warp has no scripting API. Wait until Warp is frontmost, then paste the clipboard and press Return.
-- Usage: osascript warp-paste.applescript <bundle id> warm|cold
-- Prints "ok", or "timeout" when Warp never came to the front (nothing is typed then).
on run argv
	set bundleId to item 1 of argv
	set ready to false
	repeat 60 times
		try
			tell application "System Events" to set frontId to bundle identifier of first application process whose frontmost is true
			if frontId is bundleId then
				set ready to true
				exit repeat
			end if
		end try
		delay 0.1
	end repeat
	if not ready then return "timeout"
	if (item 2 of argv) is "cold" then
		delay 2
	else
		delay 0.7
	end if
	tell application "System Events"
		tell (first application process whose frontmost is true)
			if bundle identifier is not bundleId then return "timeout"
		end tell
		keystroke "v" using command down
		delay 0.15
		key code 36
	end tell
	return "ok"
end run
