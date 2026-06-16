# Access Control List

## Purpose

This app uses explicit role boundaries. Anything not listed as allowed should be treated as denied by default.

## Roles

### Public visitor

- Can load public static assets and the launcher shell
- Can call health and access-check endpoints
- Cannot create content
- Cannot manage employees
- Cannot view protected HR or Webmaster data
- Cannot complete first-run admin setup without the deployment setup secret
- Cannot provision webmaster access

### Bootstrap operator

- Must control server configuration
- Must know `ADMIN_SETUP_TOKEN`
- Can complete first-run `POST /api/hr/setup` only while HR access is still unconfigured
- Should remove or rotate `ADMIN_SETUP_TOKEN` after provisioning

### Employee

- Can authenticate with username and password
- Can access employee board content after login
- Can enroll for employee-scoped notifications where the server authorizes that flow
- Cannot access HR or Webmaster functions

### HR admin

- Authenticates with the management password
- Can create, modify, and delete protected company content
- Can create employees, reset employee passwords, disable employees, and revoke employee sessions
- Can access HR-only protected APIs
- Can review the security events screen and recent authentication events
- Can provision the initial webmaster password through the protected HR flow
- Cannot use webmaster-only routes unless separately signed in as webmaster

### Webmaster

- Authenticates with a separate webmaster password
- Uses a separate session and cookie boundary from HR
- Can access protected webmaster summaries and operational views
- Can use webmaster-scoped mutation endpoints that require the webmaster CSRF token
- Cannot use HR-only employee-management or publishing routes unless separately signed in as HR

## Authentication Controls

### First-run bootstrap

- `POST /api/hr/setup` requires:
  - same-origin request
  - valid `ADMIN_SETUP_TOKEN`
  - HR admin not already configured

### Webmaster provisioning

- `POST /api/webmaster/setup` requires:
  - same-origin request
  - valid HR session
  - valid HR CSRF token
  - webmaster access not already configured

### HR login

- `POST /api/hr/login` requires:
  - same-origin request
  - valid management password
  - IP-based and account-based rate limiting
  - temporary backoff and lockout on repeated failures

### Webmaster login

- `POST /api/webmaster/login` requires:
  - same-origin request
  - valid webmaster password
  - IP-based and account-based rate limiting
  - temporary backoff and lockout on repeated failures

### Employee login

- `POST /api/employee/login` requires:
  - same-origin request
  - valid username and password
  - IP-based and account-based rate limiting
  - temporary backoff and lockout on repeated failures

## Failure Visibility

- Failed and throttled login attempts are written into the persisted security state
- Failed and throttled login attempts are also written to server logs with:
  - actor
  - account key
  - source IP
  - failure detail
- HR can review recent persisted authentication events from the in-app security screen

## Proxy and Origin Trust

- `PUBLIC_BASE_URL` is required and must be the deployed public origin only, with no path, query, or fragment
- `TRUST_PROXY_ADDRESSES` may list only the actual reverse proxy IP addresses that are allowed to influence forwarded host and protocol handling
- Untrusted clients do not control `X-Forwarded-Host` or `X-Forwarded-Proto` handling

## Current Risk Notes

- HR and Webmaster are now separated in sessions, but privilege boundaries still depend on password-only auth
- Least privilege is improved, but future work should add stronger auth for privileged roles if the app becomes customer-facing
- Proxy trust still requires correct deployment configuration to be safe
