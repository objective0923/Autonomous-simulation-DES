# Windows 10/11 설치·테스트

일반 PowerShell에서 실행합니다. 이미 설치된 도구는 먼저 확인하고, 없는 항목만 설치하세요. 프로젝트 명령에는 PowerShell의 npm.ps1 실행 정책에 의존하지 않는 `npm.cmd`를 사용합니다.

## 1. 현재 설치 확인

```powershell
winget --version
git --version
node --version
uv --version
```

Node는 22.12 이상이어야 하며 권장 버전은 24입니다. Python이 전역에 없어도 uv가 이 프로젝트용 Python 3.12를 설치합니다.

## 2. 누락 도구 설치

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id astral-sh.uv -e --source winget
```

설치된 항목은 건너뛰세요. 설치가 끝나면 PowerShell 창을 닫고 다시 열어 PATH를 반영합니다. `winget` 자체가 없다면 Microsoft의 App Installer를 설치하거나 공식 Git·Node.js·uv 설치 프로그램을 사용하세요.

## 3. 저장소와 의존성 설치

사용자 폴더에 프로젝트를 받는 예입니다. 다른 작업 폴더를 지정해도 됩니다.

```powershell
cd $env:USERPROFILE
git clone --branch main https://github.com/objective0923/Autonomous-simulation-DES.git
cd Autonomous-simulation-DES
uv python install 3.12
uv sync --frozen
npm.cmd ci
npm.cmd run dev
```

이미 저장소를 받은 경우에는 해당 폴더로 이동하고 `git pull --ff-only` 후 설치 명령을 실행합니다. 로컬 변경이 있으면 덮어쓰거나 초기화하지 말고 먼저 보관하세요.

웹과 SimPy API가 함께 시작되면 터미널을 열어 둔 채 브라우저에서 웹 개발 서버의 5173 포트를 엽니다. API는 8000 포트를 사용합니다. 종료는 실행 터미널에서 Ctrl+C입니다.

## 4. 첫 기능 테스트

1. 내장 예제의 **전체 계산**을 누릅니다. 시드 42·1,800초에서 생산 6개·운송 18건이 기준 결과입니다.
2. **공간 · 랙 사전 설계**에서 **첨부 2,699 mm 예제 적용**을 누릅니다. 6단 측면도·단별 높이와 입력 근거 미확인 상태를 확인합니다.
3. 단수를 20으로 바꿔 작업면·피치·천장 조건의 위반이 표시되는지 확인합니다.
4. PDF를 올리고 알려진 치수의 두 점과 실제 거리(m)를 지정합니다. 3D 배치 후보는 실제 로봇 외형과 통로 조건을 입력한 뒤 확인하세요.

별도 PowerShell에서 다음 검증을 실행할 수 있습니다.

```powershell
cd $env:USERPROFILE\Autonomous-simulation-DES
npm.cmd run test:api
npm.cmd test
npm.cmd run build
```

브라우저 자동 검증의 기본 Chromium은 Linux용입니다. Windows에서는 일반 웹 기능 테스트에 이 바이너리가 필요하지 않습니다. 자동 검증까지 실행하려면 `CHROMIUM_PATH`에 설치된 Chrome/Chromium의 실제 실행파일 경로를 지정하세요.

오류가 발생하면 실패한 명령과 오류 문구를 공유하세요. 토큰·비밀번호는 포함하지 마세요. 이 절차의 Windows 실기 실행은 사용자 PC에서 확인하며, 현재 클라우드 검증 환경은 Linux입니다.
