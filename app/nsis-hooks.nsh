!define MUI_LANGDLL_ALWAYSSHOW

!macro NSIS_HOOK_POSTINSTALL
  ; Create uninstall shortcut in Start Menu
  CreateShortCut "$SMPROGRAMS\${STARTMENUFOLDER}\Uninstall ${PRODUCTNAME}.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
  ; Create debug mode shortcut in Start Menu
  CreateShortCut "$SMPROGRAMS\${STARTMENUFOLDER}\${PRODUCTNAME} - debug.lnk" "$INSTDIR\${MAINBINARYNAME}" "/debug" "$INSTDIR\${MAINBINARYNAME}" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove uninstall shortcut from Start Menu
  Delete "$SMPROGRAMS\${STARTMENUFOLDER}\Uninstall ${PRODUCTNAME}.lnk"
  ; Remove debug mode shortcut from Start Menu
  Delete "$SMPROGRAMS\${STARTMENUFOLDER}\${PRODUCTNAME} - debug.lnk"
!macroend
