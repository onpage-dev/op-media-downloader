; The installer's hooks (tauri.bundle.conf.json): opmd, installed beside the
; app, goes on the user's PATH, so any new terminal finds it; uninstalling takes
; it off. opmd edits the PATH itself: NSIS strings stop at 1,024 characters, and
; a longer PATH read and written back here would be cut.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$INSTDIR\opmd.exe" path add "$INSTDIR"'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$INSTDIR\opmd.exe" path remove "$INSTDIR"'
  Pop $0
!macroend
