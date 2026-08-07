# Beginner Guide: What To Do When The App Looks Black Or Blank

**Document status:** Verified August 7, 2026.

Use this guide when the portal is black, blank, partly loaded, or missing its normal buttons.

## Before You Start

- Keep the problem page open if possible.
- Note the time and the phone/computer you are using.
- Do not include passwords, recovery keys, authenticator codes, or temporary credentials in screenshots.

## Step 1: Reopen The Main App Page

Open:

`https://itotexpress.com/palzivalerts`

If the normal launcher appears, choose the correct role and sign in again.

If you see `New portal update available`, select `Reload now`.

## Step 2: Check The Public Health Page

Open:

`https://itotexpress.com/api/health`

This is the public server-alive check. It should show a short response containing:

`"ok": true`

## Step 3: Use The Result

- If the health page shows `"ok": true`, the server is responding and the problem may be a stale app tab, browser cache, sign-in state, or client-side error.
- If the health page does not load, the public service, tunnel, DNS, network, or host may be unavailable.
- If only one role page fails, write down the exact role URL.

## Step 4: Send A Safe Support Report

Take one screenshot of the problem page or public health page. Send it with:

- The time the problem happened
- The device and browser
- The exact page you opened
- Whether the public health page showed `"ok": true`
- What you expected to see

Do not send a screenshot containing a typed password or authenticator code.

## Step 5: Protected Diagnostics Are For Systems Or IT

The detailed diagnostics route is:

`https://itotexpress.com/api/health/diagnostics`

It requires an authorized Systems or IT session. An employee or signed-out browser may receive `Unauthorized`; that is expected and does not mean the server is down.

Systems or IT can use the protected result to review recent client errors such as `blank-screen`, `runtime-error`, or `unhandled-rejection` before escalating.

## Quick Meaning Guide

- Main page works after `Reload now`: stale cached app assets were likely replaced.
- Public health works but the portal is blank: browser/client-side or sign-in-state problem.
- Public health fails publicly but works on the host: tunnel, DNS, firewall, or public path problem.
- Public and local health both fail: app process or host problem.
- Protected diagnostics says `Unauthorized`: sign in as Systems or IT before using that route.

## Safe Reminder

The public health result is safe to use for the first check. Detailed diagnostics are restricted because they contain operational information.
