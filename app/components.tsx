import { getConfig } from "../lib/config.ts";

/** Shown on every page that needs the API when CBC_API_KEY isn't set. */
export function ConfigBanner() {
  const config = getConfig();
  if (!config.hasApiKey) {
    return (
      <div className="alert alert-warn" role="status">
        <strong>Set CBC_API_KEY to get started.</strong> Copy <code>.env.example</code> to <code>.env.local</code>, paste
        your sandbox key (<code>pk_test_...</code>, self-serve at{" "}
        <a href="https://join.cbgc.io/sandbox/">join.cbgc.io/sandbox</a>) and restart the app. Nothing is sent to the
        API until a key is set.
      </div>
    );
  }
  if (config.keyWarning) {
    return (
      <div className="alert alert-bad" role="alert">
        <strong>Key and environment don&apos;t match.</strong> {config.keyWarning}
      </div>
    );
  }
  return null;
}

/** Flash messages passed as ?msg= / ?err= after a form posts. Rendered as text only. */
export function Notice({ msg, err }: { msg?: string; err?: string }) {
  return (
    <>
      {msg ? (
        <div className="alert alert-ok" role="status">
          {msg}
        </div>
      ) : null}
      {err ? (
        <div className="alert alert-bad" role="alert">
          {err}
        </div>
      ) : null}
    </>
  );
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
