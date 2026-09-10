Atomic Agent — first launch on macOS
====================================

This build is signed ad-hoc, not with an Apple Developer ID, and it has not
been notarised. macOS will therefore refuse to open it on the first try and
say it "cannot be opened because Apple cannot check it for malicious
software". That message is about the absence of a paid signing certificate,
not about anything found in the app.

To open it the first time:

  1. Drag Atomic Agent to Applications.
  2. In Applications, right-click (or Control-click) Atomic Agent and choose
     Open, then Open again in the dialog.

     If macOS offers no Open button, go to
       System Settings → Privacy & Security
     scroll to Security, and click "Open Anyway" next to Atomic Agent.

  3. After that it opens normally, like any other app.

The microphone
--------------
Voice input asks for the microphone the first time you use it. macOS ties
that permission to the app's code signature, and an ad-hoc signature changes
with every build — so a new build of this app is a new identity to macOS and
it will ask again. A Developer ID certificate is what makes the grant stick.

What is inside
--------------
The app carries its own copy of the Atomic Agent runtime, so nothing else
needs installing. It never touches an `atag` you may already have on your
PATH, and it keeps its own settings in ~/.atomic-agent-desktop, separate
from the terminal agent's ~/.atomic-agent.

Licences
--------
See LICENSE.txt and THIRD-PARTY-NOTICES.txt inside the app bundle
(right-click the app → Show Package Contents → Contents/Resources).
