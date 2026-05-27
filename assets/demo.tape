# Atomic Agent TUI demo recording.
# Run with: vhs assets/demo.tape

Output assets/demo.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontFamily "Menlo"
Set FontSize 14
Set Width 1500
Set Height 950
Set Padding 36
Set Framerate 30
Set WindowBar "Colorful"
Set TypingSpeed 35ms

Hide
Type "export FORCE_COLOR=3 COLORTERM=truecolor TERM=xterm-256color; unset NO_COLOR"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 500ms
Show

Type "atomic-agent"
Enter
Sleep 5s

Type "Hi! Briefly introduce yourself."
Enter
Sleep 9s

Type "What's the weather like today?"
Enter
Sleep 36s

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 1s
