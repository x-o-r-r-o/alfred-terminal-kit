-- Type a command into a new iTerm2 window or tab. Usage: osascript iterm.applescript <command> window|tab
on run argv
	set theCommand to item 1 of argv
	set inTab to (item 2 of argv) is "tab"
	set wasRunning to application id "com.googlecode.iterm2" is running
	tell application id "com.googlecode.iterm2"
		activate
		if not wasRunning then
			-- Launching opens a window: use it instead of opening a second one.
			repeat 50 times
				if (count of windows) > 0 then exit repeat
				delay 0.1
			end repeat
		end if
		if (count of windows) = 0 then
			set theSession to current session of (create window with default profile)
		else if not wasRunning then
			set theSession to current session of current window
		else if inTab then
			tell current window to set theTab to (create tab with default profile)
			set theSession to current session of theTab
		else
			set theSession to current session of (create window with default profile)
		end if
		tell theSession to write text theCommand
	end tell
end run
