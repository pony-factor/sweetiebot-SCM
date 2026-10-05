on run
    set toolkitPath to (POSIX path of (path to me)) & "Contents/Resources/toolkit/"
    set installCommand to "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; export PYTHONDONTWRITEBYTECODE=1; cd " & quoted form of toolkitPath & " && python3 scripts/install.py"
    try
        do shell script installCommand
        display dialog "Sweetiebot is installed.\n\nClose and reopen your VS Code windows to load the buttons. Run this app again after a VS Code update." with title "Sweetiebot Installer" buttons {"Done"} default button "Done" with icon note
    on error errorMessage number errorNumber
        if errorNumber is -128 then return
        if errorMessage contains "Operation not permitted" or errorMessage contains "Permission denied" then
            display dialog "macOS needs your permission to update VS Code.\n\nIn System Settings → Privacy & Security → App Management, allow Sweetiebot Installer. If it is not listed, use + to add this app.\n\nThen double-click this app again." with title "Sweetiebot Installer" buttons {"Later", "Open Settings"} default button "Open Settings" with icon caution
            if button returned of result is "Open Settings" then do shell script "/usr/bin/open '/System/Applications/System Settings.app'"
        else
            display dialog "Sweetiebot could not finish installing.\n\n" & errorMessage with title "Sweetiebot Installer" buttons {"OK"} default button "OK" with icon stop
        end if
    end try
end run
