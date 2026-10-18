; Tauri CLI 2.12.1 exposes this checkbox/state in its NSIS uninstaller.
; Keep the default unchecked choice. Never purge on /UPDATE, /P or /S.
!macro NSIS_HOOK_PREUNINSTALL
  !if "${INSTALLMODE}" != "currentUser"
    !error "Quorb delete-data cleanup only supports currentUser installers"
  !endif
  ; The template also deletes AppData later. Disarm its checkbox in every
  ; keep-data mode, including installer-driven manual upgrades/reinstalls (_?=).
  ${If} $UpdateMode = 1
  ${OrIf} $PassiveMode = 1
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
  ${If} ${Silent}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "_?=" $0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
  ClearErrors
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    ${IfNot} ${Silent}
      ; Close the app before deleting WebView/session data. The default template
      ; repeats this check later; do not run cleanup after deleting the binary.
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quorb-uninstall-cleanup --delete-data --channel ${BUNDLEID}' $0
      ${If} ${Errors}
        StrCpy $0 2
      ${EndIf}
      ${If} $0 <> 0
        ; A partial cleanup is possible (e.g. a locked file). Keep the installed
        ; app available for a retry; never silently report successful cleanup.
        MessageBox MB_OK|MB_ICONSTOP "Could not safely delete ${PRODUCTNAME} data (code $0). Uninstall stopped. Some data may already have been removed. Close the app and retry, or keep data by leaving the checkbox unchecked."
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
