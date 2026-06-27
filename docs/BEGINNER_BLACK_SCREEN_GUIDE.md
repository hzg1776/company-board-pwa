# Beginner Guide: What To Do When The App Looks Black Or Blank

This guide is for beginners.

Use it when:

- the page opens but looks black or empty
- the app does not show the buttons or login boxes you expect
- you need to send a useful screenshot to support or management

## Before you start

You only need:

- a web browser
- the app web address
- 2 to 3 minutes

Do not type any passwords into screenshots.

## Step 1: Open the main app page

Open the normal app page first.

Example:

`https://itotexpress.com/palzivalerts`

What you should normally see:

- the Palziv logo
- the page title
- login buttons such as Employee Login and HR Login

If you see that normal screen, the app is loading.

## Step 2: If the page still looks wrong, open the diagnostics page

Click in the browser address bar.

Type the diagnostics address and open it:

`https://itotexpress.com/api/health/diagnostics`

If you are checking a local server, use the same format:

`http://localhost:3116/api/health/diagnostics`

## Step 3: Check for `"ok": true`

When the diagnostics page loads, look near the top of the page.

You want to see:

`"ok": true`

This means the server is responding.

## Step 4: Look for recent blank-screen or client errors

On the same diagnostics page, look for these sections:

- `recentEvents`
- `recentErrors`

If you see items like `blank-screen`, `runtime-error`, or `unhandled-rejection`, that means the browser had a client-side problem even if the server stayed online.

## Step 5: Take one screenshot and send it

Take a screenshot of the diagnostics page.

Send the screenshot with this short note:

- the time you saw the problem
- whether you were on phone or computer
- whether the main page was completely blank or only partly loaded

## Quick meaning guide

- Main page loads normally: app is probably fine right now
- `"ok": true` but `blank-screen` appears: browser/client problem
- Diagnostics page does not open: app or server path is down
- Public site fails but local site works: tunnel, DNS, or public path problem

## Safe reminder

Do not include:

- passwords
- recovery codes
- private employee data

Only send the screen that shows the page state and diagnostics.
