; 相拥 · 关系分析室（抓取版）安装脚本 v0.4.0 —— 内置本地小AI
#define MyAppName "相拥 · 关系分析室"
#define MyAppVersion "0.4.0"
#define MyAppExeName "electron.exe"
#define MyAppId "XY-REL-ANALYZER-2026"

[Setup]
AppId={{XY-REL-ANALYZER-2026}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=xiangyong
DefaultDirName={localappdata}\ta-love-app-grab
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=C:\Users\35873\Desktop
OutputBaseFilename=相拥-安装包
SetupIconFile=E:\ta-love-app-grab-build\app\app.ico
UninstallDisplayIcon={app}\app\app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "ChineseSimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "E:\ta-love-app-grab-build\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\app.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\app.ico"; Tasks: desktopicon
Name: "{autoprograms}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"; IconFilename: "{app}\app\app.ico"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\app\node_modules\electron\dist\electron.exe"; Parameters: "--no-sandbox ""{app}\app"""; WorkingDir: "{app}\app"; Description: "立即启动 相拥 · 关系分析室"; Flags: nowait postinstall skipifsilent
