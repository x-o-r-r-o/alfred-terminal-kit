-- Type a command into a new Terminal window. Usage: osascript terminal.applescript <command>
on run argv
	set theCommand to item 1 of argv
	set wasRunning to application id "com.apple.Terminal" is running
	tell application id "com.apple.Terminal"
		if wasRunning then
			do script theCommand
		else
			-- Launching opens a window: use it instead of opening a second one.
			activate
			repeat 50 times
				if (count of windows) > 0 then exit repeat
				delay 0.1
			end repeat
			if (count of windows) > 0 then
				do script theCommand in window 1
			else
				do script theCommand
			end if
		end if
		activate
	end tell
end run
