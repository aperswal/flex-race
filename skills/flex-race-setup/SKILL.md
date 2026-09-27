---
name: flex-race-setup
description: Use this skill to add flex-race to a TypeScript or JavaScript app that calls the OpenAI Responses API through the official openai SDK. Use it when the user wants to try flex for calls that may wait.
---

flex-race lets an app try flex with a set wait before it falls back to the default tier. The app already calls responses.create through an OpenAI client. This change adds withFlex around that client and start_by to calls where the user agrees to a delay. This skill applies only to OpenAI's Responses API, not Chat Completions calls or other providers.

1. Find where the app builds its OpenAI client and calls responses.create. Trace shared request fields too. Check the app's runtime, SDK version, package manager, and test command. The [package rules](../../package.json) require Node.js 20 or later and openai 6 or later as a peer dependency. The package exports an ES module. The [wrapper](../../src/with-flex.ts) returns a plain Promise, so check for SDK Promise helpers before you wrap a shared client.

2. Ask the user for the install source: a registry name, a git URL, or a local tarball path. The package is not published to npm. Its install source is unknown. Do not guess the source. Show the user the calls you found. Ask which calls may wait and how long each may wait. Wait for those answers before you install or add start_by. Leave calls without an agreed delay unchanged.

3. Explain the wait before the user sets it. start_by sets the time by which flex must admit the request. It does not set a time by which the response must finish. The [time parser](../../src/start-by.ts) skips flex when less than 5 seconds remain. It caps the flex wait at 10 minutes. These are package limits. If flex fails before admission or the wait ends, the wrapper aborts flex and calls the default tier. After admission, a full response may fall back on failure. A stream passes later events and errors to the caller. The [fallback code](../../src/with-flex.ts) passes default errors to the caller and honors the caller's abort signal.

4. Install the user-supplied source with the app's package manager. Import withFlex from flex-race and wrap the existing client. Keep the client's settings and credentials. The app still owns its credentials and access checks. The wrapper adds no stored records or access checks. Set onOutcome to send tier, reason, waitedMs, and capped to the app's logs for each call with start_by. The [outcome code](../../src/with-flex.ts) reports flex or default. Calls without start_by emit no outcome. Some errors also end the call with no outcome. A default outcome comes before the request finishes, so check the call result too.

5. Add start_by only to the agreed calls. Build an ISO string with seconds and a timezone at call time. Use the agreed delay in milliseconds as ms:

   ```js
   start_by: new Date(Date.now() + ms).toISOString();
   ```

   Do not store a fixed start_by string in config. Never pass service_tier with start_by, including through shared request fields. Remove service_tier only for the agreed calls. The wrapper strips start_by before it calls OpenAI. Keep streaming code unchanged, including stream, event handlers, and loops.

6. Run the project's own tests after the change. Check the agreed calls, unchanged calls, stream event order, fallback, and outcome logs with the project's test tools. Run its type check if it has one. Report the results and any checks you could not run. Claim that the app works only when test results support that claim. Keep mock test results separate from live OpenAI results.
