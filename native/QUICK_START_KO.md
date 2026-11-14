# OpenCapture 빠른 실행 도우미

`OpenCaptureQuick.exe`는 Windows 트레이에서 대기하며 전역 단축키만
담당합니다. 캡처 화면을 별도로 구현하지 않고, 모든 캡처 요청을 같은 폴더의
`OpenCapture.exe --broker --native-dispatch --capture`로 전달하므로 일반 앱과
동일한 선택·주석·임시 보관 흐름을 사용합니다.

- 기본 영역 캡처: **Ctrl+Shift+A**
- 기본 시작 화면: **Ctrl+Shift+Space**
- 앱 설정에서 바꾼 키는 `config.json`의 `起始页快捷键` 값을 읽어
  실행 중에 다시 등록합니다. 빈 문자열은 해당 키를 끕니다.
- 일반 OpenCapture가 실행되면 도우미는 단축키를 반납합니다. 일반 앱이
  종료되면 도우미가 다시 등록합니다. 두 프로세스가 같은 키를 동시에
  소유하지 않습니다.
- 실제 등록 결과와 충돌·설정 오류는 트레이 메뉴 및
  `hotkey-helper-state.json`에서 확인할 수 있습니다.

도우미는 Windows .NET Framework를 사용하며 별도 npm 설치가 필요하지
않습니다. 빌드:

```powershell
.\scripts\build-quicklaunch.ps1
```

결과는 `native/bin/OpenCaptureQuick.exe`입니다. 패키지에서는
`OpenCapture.exe` 옆에 배치합니다. 자동 검증은 키 등록·중복 거부·소유권
전환·설정 재로딩을 확인하지만, 합성 입력을 실제 물리 키 입력으로 주장하지
않습니다.
