# flex-race

flex-race lets your app try OpenAI's flex tier with a set wait for it to start. If flex takes too long or fails before it starts, the wrapper sends the request to the default tier. This gives your app a way to use flex while limiting the wait for flex to accept the work. The [wrapper](src/with-flex.ts) adds start_by to responses.create on an OpenAI client.

## Install

The [package](package.json) needs Node.js 20 or later and openai 6 or later. It exports an ES module. Install it and the OpenAI SDK from npm:

```sh
npm install flex-race openai
npm install --save-dev tsx
```

## Usage

Save this TypeScript example as example.ts. It sets start_by to an ISO string with a timezone. The time is 120 seconds from the call.

```ts
import OpenAI from "openai";
import { withFlex } from "flex-race";

async function main() {
  const client = withFlex(new OpenAI(), {
    onOutcome(outcome) {
      console.log(outcome);
    },
  });

  const response = await client.responses.create({
    model: "gpt-6-luna",
    input: "Reply with the single word: ok",
    start_by: new Date(Date.now() + 120_000).toISOString(),
  });

  console.log(response.output_text);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

Set OPENAI_API_KEY to your key, then run the example:

```sh
export OPENAI_API_KEY="your-api-key"
npx tsx example.ts
```

For a stream, set stream to true in the request. Use for await to read the returned stream. The wrapper returns the flex events it read while waiting before it returns the rest of the events. Without start_by, the wrapper passes the request to the client and does not call onOutcome. Other client methods stay in place, including responses.retrieve. The [wrapper](src/with-flex.ts) returns a plain Promise from responses.create.

## How the wait works

start_by sets the time by which flex must admit the request. Admission means the wrapper has read an event after response.in_progress without a thrown error or a response.failed event. On gpt-4o, the live check saw response.in_progress followed by invalid_request_error. This is why [the race](src/race.ts) waits for the next event before it counts admission.

The wrapper uses a stream for every flex attempt, even when your app asks for a full response. It counts the time spent opening the stream as part of the wait. Once flex admits the request, the timer stops. For a full response, the wrapper then reads until response.completed or response.incomplete. start_by does not set a time by which the response must finish. The default request can also run past start_by. See [the race](src/race.ts) and [the wrapper](src/with-flex.ts).

The [time parser](src/start-by.ts) requires an ISO 8601 string with seconds and Z or a timezone offset such as +05:00. Bad dates, strings with no timezone, Date objects, and numbers cause StartByError before any request. Passing start_by with a non-null service_tier also causes StartByError.

The wrapper skips flex when less than 5 seconds remain, including when start_by has passed. It caps the wait at 10 minutes when start_by is farther away. These are local code limits set by MIN_LEAD_MS and MAX_WINDOW_MS in [the time parser](src/start-by.ts). The clock defaults to Date.now. The now option lets tests supply a clock.

## Fallback and errors

If the wait ends before admission, the wrapper aborts the flex attempt and starts a default request. It does the same if flex throws an error, sends response.failed, or ends the stream before admission. The wrapper tries any model on flex when enough time remains. It keeps no list of models with a flex tier. A model with no flex tier thus adds a flex attempt before the default request. See [the fallback code](src/with-flex.ts).

After admission, a full response and a stream have different failure rules. For a full response, the wrapper starts a default request if flex sends response.failed or ends without a final response. It also retries thrown errors on the default tier unless the error has type invalid_request_error or the caller has aborted. For a stream, it passes later events and errors to the caller without starting a default request. The [wrapper](src/with-flex.ts) passes errors from the default request to the caller.

Your app supplies the OpenAI client and its credentials. The wrapper adds no access checks or stored records. It removes start_by before sending the body to OpenAI. For flex, it sets service_tier to flex, stream to true, and maxRetries to 0. For fallback, it sets service_tier to default and keeps the caller's stream choice and request options. The caller's abort signal also aborts the flex attempt. An abort during the wait ends the call without fallback. See [the request and abort code](src/with-flex.ts).

## Outcomes

The onOutcome option receives a FlexOutcome with tier, reason, waitedMs, and capped. tier is flex or default. capped is true when the wrapper cut the wait to MAX_WINDOW_MS. waitedMs counts from the call to the report. For a flex stream, the report comes at admission. For a full flex response, it comes after the final response. A report for the default tier comes before that request finishes, so it does not prove that the request passed. See [the outcome code](src/with-flex.ts).

The reason is admitted when the wrapper uses flex. It is deadline_too_near when the wrapper skips flex, or deadline_elapsed when the wait runs out. It is flex_refused when flex fails before admission. It is flex_failed_after_admission when a full response fails after admission and the wrapper starts a default request. Calls without start_by, bad input, and errors that end the call before a tier report do not call onOutcome. The [public exports](src/index.ts) include the outcome types and StartByError.

## Tests and live results

Run the unit tests from this repo:

```sh
pnpm test
```

The [time tests](src/start-by.test.ts) check valid times, bad input, and the wait cap. The [wrapper tests](src/with-flex.test.ts) check admission, event order, fallback, errors, and aborts. They use a simulated clock to check that the wrapper aborts a waiting flex attempt when start_by passes. The confirmed run on 2026-09-26 passed 57 unit tests and covered every source line.

The live tests read OPENAI_API_KEY from a local .env file through the [live test config](vitest.live.config.ts). Add your key to that file:

```dotenv
OPENAI_API_KEY=your-api-key
```

Then run:

```sh
pnpm test:live
```

The [live tests](test/openai.live.test.ts) skip when no key is set. They call the live OpenAI API. They check full responses, streams, fallback for a model with no flex tier, and a start_by too near to try flex. For full responses and streams, they check that the served tier matches onOutcome. The confirmed run on 2026-09-26 passed all 4 live tests.

Separate checks on 2026-09-26 installed the packed tarball in another project and called the live OpenAI API. With start_by 120 seconds ahead, gpt-6-luna returned a full response on flex with reason admitted and waitedMs 990. A gpt-6-sol stream used flex with reason admitted and waitedMs 647. That stream had 9 events. A gpt-4o request used the default tier with reason flex_refused and waitedMs 638.

Those checks also saw deadline_too_near on the default tier with start_by 2 seconds ahead. A call without start_by passed through with no onOutcome call. A start_by with no timezone threw StartByError before any request. responses.retrieve also worked through the wrapper.

The path where start_by passes while flex still waits has not been seen live. Live flex admissions took about one second. The simulated clock tests cover that path. These measured times do not set a speed target or a guarantee. A live check also saw gpt-6-astra served on flex. What OpenAI bills for that request is unknown because its pricing page listed no flex price.
