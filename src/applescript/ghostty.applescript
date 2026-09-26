-- Ghostty 1.3+: open a window or tab in a folder and optionally type a command.
-- Usage: osascript ghostty.applescript <dir> <command or ""> window|tab
on run argv
	set theDir to item 1 of argv
	set theCommand to item 2 of argv
	set inTab to (item 3 of argv) is "tab"
	set wasRunning to application id "com.mitchellh.ghostty" is running
	tell application id "com.mitchellh.ghostty"
		activate
		if not wasRunning then
			-- Launching opens a window: use it instead of opening a second one.
			repeat 50 times
				if (count of windows) > 0 then exit repeat
				delay 0.1
			end repeat
		end if
		if (not wasRunning) and (count of windows) > 0 then
			set term to focused terminal of selected tab of front window
			if theDir is not "" then
				input text ("cd " & quoted form of theDir) to term
				send key "enter" to term
			end if
		else
			set cfg to new surface configuration
			if theDir is not "" then set initial working directory of cfg to theDir
			if inTab and (count of windows) > 0 then
				set theTab to new tab in front window with configuration cfg
				set term to focused terminal of theTab
			else
				set theWindow to new window with configuration cfg
				set term to focused terminal of selected tab of theWindow
			end if
		end if
		if theCommand is not "" then
			input text theCommand to term
			send key "enter" to term
		end if
	end tell
end run
