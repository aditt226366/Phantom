/**
 * The Apps Script a tenant pastes into their own spreadsheet.
 *
 * ---------------------------------------------------------------------------
 * It is a doorbell, and that is the whole design
 * ---------------------------------------------------------------------------
 *
 * The script sends no rows. It says "something changed, look now", and the poll
 * that follows reads the sheet through the same credential, the same cleaning
 * and the same unique index as every scheduled poll.
 *
 * Two things fall out of that, and both are the reason it is shaped this way:
 *
 *   - There is no second ingestion path. A webhook that carried rows would
 *     need its own idea of what a header is, its own normalisation, and its own
 *     opportunity to miss the index that stops a customer being messaged twice.
 *   - There is nothing worth forging. The worst an attacker with the URL can do
 *     is make us read a spreadsheet we were going to read anyway, sooner. They
 *     cannot inject a lead, name a company, or reach another tenant - the
 *     company id comes from app_resolve_company, never from the request.
 *
 * Polling stays the default and the fallback. This is an optimisation for
 * somebody who needs a lead contacted in seconds rather than in half a minute,
 * and a tenant who never pastes it loses nothing but latency.
 */

/** Seconds Apps Script waits before giving up. Its own limit is 30. */
const SCRIPT_TIMEOUT_SECONDS = 10;

/**
 * The script text, with this binding's URL in it.
 *
 * Deliberately readable rather than minified. A tenant is pasting code into
 * their own spreadsheet, and code they cannot read is code they should not
 * paste - the comments are as much a part of what makes this acceptable to
 * install as the behaviour is.
 *
 * `onChange` rather than `onEdit`: a form submission and a script-appended row
 * do not fire onEdit at all, and a form is where most of these rows come from.
 * The installable trigger is what the setup instructions add.
 *
 * muteHttpExceptions, and nothing is done with the response. If the ping fails
 * the scheduled poll picks the row up within the interval anyway, so a retry
 * loop here would add a way for a tenant's spreadsheet to hammer us in exchange
 * for latency it already has a floor on.
 */
export function appsScriptSource(webhookUrl: string): string {
  return `/**
 * whatsapp-os lead source - tells your workspace to read this sheet now.
 *
 * It sends no data. It only says "something changed", and the read that
 * follows uses the access you already granted by sharing this spreadsheet.
 * If this ever fails, nothing is lost: the sheet is read on a schedule anyway
 * and this only makes it sooner.
 */
function whatsappOsNotify() {
  UrlFetchApp.fetch(${JSON.stringify(webhookUrl)}, {
    method: "post",
    muteHttpExceptions: true,
    // Nothing is read from the response. A failed ping costs latency, not a
    // lead, so retrying here would only add a way to hammer the server.
    payload: "",
  });
}

/**
 * Run once, by hand, from the Apps Script editor.
 *
 * Creates the onChange trigger. onChange rather than onEdit because a form
 * submission and a script-appended row do not fire onEdit at all - and a form
 * is where most leads come from.
 */
function whatsappOsInstall() {
  var sheet = SpreadsheetApp.getActive();

  // Remove any trigger this script installed before, so running the installer
  // twice does not ring the bell twice per edit.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "whatsappOsNotify") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("whatsappOsNotify")
    .forSpreadsheet(sheet)
    .onChange()
    .create();
}
`;
}

/** The URL the script posts to. One join, so a stray slash cannot appear. */
export function leadSourceWebhookUrl(appUrl: string, webhookKey: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/lead-source/${webhookKey}`;
}

/** How long the route may take before Apps Script gives up on it. */
export const APPS_SCRIPT_TIMEOUT_SECONDS = SCRIPT_TIMEOUT_SECONDS;
