; Tauri CLI 2.12.1 exposes this checkbox/state in its NSIS uninstaller.
; Keep the default unchecked choice. Never purge on /UPDATE, /P or /S.
!macro NSIS_HOOK_PREUNINSTALL
  !if "${INSTALLMODE}" != "currentUser"
    !error "Quorb delete-data cleanup only supports currentUser installers"
  !endif
  ; An uninstall abandons any unconsumed installer choice, except during update.
  ${If} $UpdateMode <> 1
    Delete "$APPDATA\${BUNDLEID}\installer-locale"
  ${EndIf}
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

; Only a completed interactive install hands its choice to the first app start.
!macro NSIS_HOOK_POSTINSTALL
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
    CreateDirectory "$APPDATA\${BUNDLEID}"
    ; Discard any previous choice before attempting a new handoff.
    Delete "$APPDATA\${BUNDLEID}\installer-locale"
    ClearErrors
    FileOpen $0 "$APPDATA\${BUNDLEID}\installer-locale" w
    ${IfNot} ${Errors}
      ${If} $LANGUAGE = 1034
        FileWrite $0 "es$\r$\n"
      ${Else}
        FileWrite $0 "en$\r$\n"
      ${EndIf}
      FileWrite $0 "${VERSION}$\r$\n"
      FileClose $0
      ; A partial write is not a choice: let the app use its own picker.
      ${If} ${Errors}
        Delete "$APPDATA\${BUNDLEID}\installer-locale"
      ${EndIf}
    ${EndIf}
  ${Else}
    Delete "$APPDATA\${BUNDLEID}\installer-locale"
  ${EndIf}
!macroend

; Tauri's NSIS template (CLI 2.12.1) includes MUI2.nsh before these hooks and
; calls MUI_LANGDLL_DISPLAY in .onInit after parsing /P and /UPDATE. Upstream it
; only skips the dialog for /S, so the passive updater would ask existing users
; for a language. This copy of NSIS Contrib/Modern UI 2/Localization.nsh
; (kichik/nsis@9465c08046f00ccb6eda985abbdbf52c275c6c4d) differs only in the
; marked mode guard. Re-check it whenever Tauri or NSIS is upgraded.
!macroundef MUI_LANGDLL_DISPLAY
!macro MUI_LANGDLL_DISPLAY

  !verbose push
  !verbose ${MUI_VERBOSE}

  !ifndef MUI_LANGDLL_LANGUAGES
    !warning "MUI_LANGDLL_DISPLAY should only be used after inserting the MUI_LANGUAGE macro(s)"
  !endif

  !insertmacro MUI_LANGDLL_VARIABLES

  !insertmacro MUI_DEFAULT MUI_LANGDLL_WINDOWTITLE "Installer Language"
  !insertmacro MUI_DEFAULT MUI_LANGDLL_INFO "Please select a language."

  !ifdef MUI_LANGDLL_REGISTRY_VARIABLES

    ReadRegStr $mui.LangDLL.RegistryLanguage "${MUI_LANGDLL_REGISTRY_ROOT}" "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
    
    ${if} $mui.LangDLL.RegistryLanguage != ""
      ;Set default language to registry language
      StrCpy $LANGUAGE $mui.LangDLL.RegistryLanguage
    ${endif}

  !endif

  ; Quorb: passive (automatic updater) and update runs keep the remembered or
  ; default language instead of asking (#233).
  ${If} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  !ifdef NSIS_CONFIG_SILENT_SUPPORT
  ${AndIfNot} ${Silent}
  !endif

  !ifndef MUI_LANGDLL_ALWAYSSHOW
  !ifdef MUI_LANGDLL_REGISTRY_VARIABLES
    ${if} $mui.LangDLL.RegistryLanguage == ""
  !endif
  !endif
  
  ;Show language selection dialog
  !ifdef MUI_LANGDLL_ALLLANGUAGES
    LangDLL::LangDialog "${MUI_LANGDLL_WINDOWTITLE}" "${MUI_LANGDLL_INFO}" A ${MUI_LANGDLL_LANGUAGES} ""
  !else
    LangDLL::LangDialog "${MUI_LANGDLL_WINDOWTITLE}" "${MUI_LANGDLL_INFO}" AC ${MUI_LANGDLL_LANGUAGES_CP} ""
  !endif
  
    Pop $LANGUAGE
    ${if} $LANGUAGE == "cancel"
      Abort
    ${endif}
  
  !ifndef MUI_LANGDLL_ALWAYSSHOW
  !ifdef MUI_LANGDLL_REGISTRY_VARIABLES
    ${endif}
  !endif
  !endif


  ${EndIf}

  !verbose pop

!macroend
