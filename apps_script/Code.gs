/**
 * ALF Write Gate (V1) — Single Script (Soft Authority)
 * Bind this script to the JOB TABLE Google Sheet.
 *
 * Writes to:
 * - Job Table (this spreadsheet)
 * - Item Master (separate spreadsheet by ID below)
 *
 * Soft Authority:
 * - No hard role/owner enforcement
 * - Still validates transitions + required fields + high-risk confirm
 * - Logs everything + stamps last-updated metadata
 */

/** ====== CONFIG ====== **/

// ✅ Item Master Spreadsheet ID (your Google Sheets version)
const ITEM_MASTER_SPREADSHEET_ID = "1SrEEmy0REefnr8oOFtlLKsMg-h_9e2BOpKCVfqkzTLE";

const SHEETS = {
  JOBS: "Job_Table_Live",
  LOG: "WRITE_LOG",

  OWNER_MAP: "STATUS_OWNER_MAP",
  TRANSITIONS: "STATUS_TRANSITIONS",
  REQUIRED: "STATUS_REQUIRED_FIELDS",

  // Item Master sheet tab name inside Item Master spreadsheet:
  ITEM_MASTER: "Item_Master",
};

// Key fields
const JOB_KEY_FIELD = "Job_Number";
const ITEM_KEY_FIELD = "Item_Code";

// Status columns
const STATUS_FIELDS = {
  STATUS: "Current_Status",
  OWNER: "Status_Owner",
  UPDATED: "Status_Last_Updated",
  NOTES: "Status_Notes",
};

// Last-updated metadata (recommended columns in both tables)
const UPDATE_META_FIELDS = {
  BY: "Last_Updated_By",
  AT: "Last_Updated_At",
  OP: "Last_Update_Operation",
};

// High-risk statuses require confirmPhrase = "CONFIRMED"
const HIGH_RISK_STATUSES = new Set([
  "Ready to Send to Customer",
  "Ready to Stage",
  "Staged – Ready to Schedule",
  "Invoice Sent",
  "Paid",
]);
const HIGH_RISK_CONFIRM_PHRASE = "CONFIRMED";

// Notes required (can be enforced via required-fields sheet too)
const STATUSES_REQUIRING_NOTES = new Set([
  "Follow-up Customer Pending",
  "Customer Accepted",
  "Deposit Received",
  "Deposit Waived",
  "PO Received",
  "Ready to Stage",
  "Staging in Progress",
  "Materials on Order",
  "Staged – Ready to Schedule",
  "Install In Progress",
  "Install Complete",
]);

// Operations
const OPERATIONS = {
  UPDATE_JOB_STATUS: "updateJobStatus",
  SET_JOB_FIELD: "setJobField",
  CREATE_JOB: "createJob",

  UPDATE_ITEM_COST: "updateItemCost",
  UPDATE_ITEM_FIELD: "updateItemField",
  CREATE_ITEM: "createItem",

  // READ OPS (new)
  GET_ITEM_COST: "getItemCost",
  GET_ITEM: "getItem",
  GET_JOB: "getJob",
  PRICE_QUOTE: "priceQuote",
};

// Allowed fields for setJobField (V1)
const JOB_FIELD_ALLOWLIST = {
  "Customer_Phone": ["ANY"],
  "Customer_Email": ["ANY"],
  "Customer_Address": ["ANY"],

  "Quote_Sent_Date": ["ANY"],

  "Deposit_Amount": ["ANY"],
  "Deposit_Received_Date": ["ANY"],

  "Ready_To_Stage_Date": ["ANY"],
  "Staging_Complete_Date": ["ANY"],

  "Install_Complete_Date": ["ANY"],

  "Invoice_Sent_Date": ["ANY"],
  "Invoice_Amount": ["ANY"],
  "Balance_Due": ["ANY"],
  "Paid_Date": ["ANY"],
  "Job_Closed": ["ANY"],

  // Metadata fields (gate-owned)
  "Last_Updated_By": ["GATE_ONLY"],
  "Last_Updated_At": ["GATE_ONLY"],
  "Last_Update_Operation": ["GATE_ONLY"],
};

// Allowed fields for updateItemField (V1)
const ITEM_FIELD_ALLOWLIST = {
  "Vendor_Name": ["ANY"],
  "Lead_Time": ["ANY"],
  "Category": ["ANY"],
  "Unit_of_Measure": ["ANY"],
  "Source_Type": ["ANY"],
  "Active_Status": ["ANY"],
  "Description": ["ANY"],
  "Weight_or_Specs": ["ANY"],
  "Notes": ["ANY"],

  // Metadata fields (gate-owned)
  "Last_Updated_By": ["GATE_ONLY"],
  "Last_Updated_At": ["GATE_ONLY"],
  "Last_Update_Operation": ["GATE_ONLY"],
};
/** ====== WEB APP ENTRY POINT ====== **/
function doPost(e) {
  try {
    // --- Header-based auth (replaces readToken in JSON) ---
    const hdrs = (e && e.headers) ? e.headers : {};
    const normalized = {};
    Object.keys(hdrs || {}).forEach(k => (normalized[String(k).toLowerCase()] = hdrs[k]));

    // Prefer a dedicated header you configure in the GPT Action auth (API Key)
    const providedKey =
      normalized["x-alf-key"] ||
      normalized["x_api_key"] ||
      normalized["x-api-key"] ||
      "";

    const expectedKey = PropertiesService.getScriptProperties().getProperty("ALF_API_KEY");

    if (!expectedKey || String(providedKey).trim() !== String(expectedKey).trim()) {
      return jsonResponse_({
        result: "REJECTED",
        message: "Unauthorized (missing or invalid API key)",
      });
    }

    // --- Parse payload ---
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const parsed = JSON.parse(raw);

    // Custom GPT Actions often send { body: { ...actualPayload... } }
    const payload = (parsed && typeof parsed === "object" && parsed.body && typeof parsed.body === "object")
      ? parsed.body
      : parsed;
    payload.__query = (e && e.parameter) ? e.parameter : {};

    // Keep normalized headers available downstream if any legacy code needs them
    payload.__headers = normalized;

    const result = dispatch(payload);
    return jsonResponse_(result);

  } catch (err) {
    return jsonResponse_({
      result: "REJECTED",
      message: "Invalid request payload",
      error: String(err),
    });
  }
}

/** ====== DISPATCHER ====== **/
function dispatch(payload) {
  if (!payload || !payload.operation) {
    return reject_("UNKNOWN", "Missing operation", payload);
  }

  switch (payload.operation) {
    // WRITE OPS
    case OPERATIONS.UPDATE_JOB_STATUS:
      return updateJobStatus_(payload);

    case OPERATIONS.SET_JOB_FIELD:
      return setJobField_(payload);

    case OPERATIONS.CREATE_JOB:
      return createJob_(payload);

    case OPERATIONS.UPDATE_ITEM_COST:
      return updateItemCost_(payload);

    case OPERATIONS.UPDATE_ITEM_FIELD:
      return updateItemField_(payload);

    case OPERATIONS.CREATE_ITEM:
      return createItem_(payload);

    // READ OPS (token-protected)
    case OPERATIONS.GET_ITEM_COST:
      requireReadToken_(payload);
      return getItemCost_(payload);

    case OPERATIONS.GET_ITEM:
      requireReadToken_(payload);
      return getItem_(payload);

    case OPERATIONS.GET_JOB:
      requireReadToken_(payload);
      return getJob_(payload);

     case OPERATIONS.PRICE_QUOTE:
      requireReadToken_(payload);
      return priceQuote_(payload);


    default:
      return reject_(payload.operation, `Unsupported operation: ${payload.operation}`, payload);
  }
}


/** ====== JOB OPS ====== **/

function updateJobStatus_(p) {
  const op = OPERATIONS.UPDATE_JOB_STATUS;

  const jobNumber = String(p.jobNumber || "").trim();
  const newStatus = String(p.newStatus || "").trim();
  const notes = String(p.notes || "").trim();
  const requestedBy = String(p.requestedBy || "").trim();
  const requestedRole = String(p.requestedRole || "").trim(); // optional; warnings only

  if (!jobNumber || !newStatus || !requestedBy) {
    return logAndReturn_(reject_(op, "Missing required inputs (jobNumber/newStatus/requestedBy)", p), op, jobNumber, p);
  }

  // Load rules (from THIS Job Table spreadsheet)
  const ownerMap = loadOwnerMap_();
  const transitions = loadTransitions_();
  const required = loadRequiredFields_();

  if (!ownerMap.has(newStatus)) {
    return logAndReturn_(reject_(op, `Unknown status: ${newStatus}`, {
      allowedStatuses: Array.from(ownerMap.keys())
    }), op, jobNumber, p);
  }

  // Find job
  const jobRef = findRowByKey_(SpreadsheetApp.getActive(), SHEETS.JOBS, JOB_KEY_FIELD, jobNumber);
  if (!jobRef.found) {
    return logAndReturn_(reject_(op, `Job not found: ${jobNumber}`, p), op, jobNumber, p);
  }

  const sheet = jobRef.sheet;
  const headers = jobRef.headers;
  const rowIndex = jobRef.rowIndex;

  const currentStatus = getCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.STATUS);

  // Transition validation
  const allowedNext = transitions.get(currentStatus) || new Set();
  if (!allowedNext.has(newStatus)) {
    return logAndReturn_(reject_(op, `Invalid status transition: '${currentStatus}' -> '${newStatus}'`, {
      currentStatus,
      requestedStatus: newStatus,
      allowedNextStatuses: Array.from(allowedNext),
    }), op, jobNumber, p);
  }

  // High-risk confirm phrase
  const confirmPhrase = String(p.confirmPhrase || "").trim().toUpperCase();
  if (HIGH_RISK_STATUSES.has(newStatus) && confirmPhrase !== HIGH_RISK_CONFIRM_PHRASE) {
    return logAndReturn_(reject_(op, `High-risk status requires confirmPhrase='${HIGH_RISK_CONFIRM_PHRASE}'`, {
      newStatus,
      requiredConfirmPhrase: HIGH_RISK_CONFIRM_PHRASE,
    }), op, jobNumber, p);
  }

  // Notes required?
  if (STATUSES_REQUIRING_NOTES.has(newStatus) && !notes) {
    return logAndReturn_(reject_(op, `Notes required to enter status: ${newStatus}`, p), op, jobNumber, p);
  }

  // Required fields check
  const missingFields = [];
  const reqSet = required.get(newStatus) || new Set();
  reqSet.forEach((fieldName) => {
    const val = getCellByHeader_(sheet, headers, rowIndex, fieldName);
    if (isBlank_(val)) missingFields.push(fieldName);
  });

  if (missingFields.length > 0) {
    return logAndReturn_(reject_(op, `Missing required fields for status '${newStatus}'`, {
      newStatus,
      missingFields,
    }), op, jobNumber, p);
  }

  // Soft authority warning (informational)
  const targetOwnerSpec = ownerMap.get(newStatus) || "";
  let warning = "";
  if (requestedRole && targetOwnerSpec && !roleMatchesOwnerSpec_(requestedRole, targetOwnerSpec)) {
    warning = `Soft authority warning: '${newStatus}' is normally owned by '${targetOwnerSpec}', but request role was '${requestedRole}'.`;
  }

  // Atomic update
  const now = new Date();
  const statusOwner = normalizeOwnerForStatus_(targetOwnerSpec, requestedRole);

  setCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.STATUS, newStatus);
  setCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.OWNER, statusOwner);
  setCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.UPDATED, now);

  const existingNotes = String(getCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.NOTES) || "");
  const combinedNotes = notes ? appendNote_(existingNotes, now, requestedBy, requestedRole, notes) : existingNotes;
  setCellByHeader_(sheet, headers, rowIndex, STATUS_FIELDS.NOTES, combinedNotes);

  // Stamp update metadata (if columns exist)
  stampUpdateMeta_(sheet, headers, rowIndex, requestedBy, now, op);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: jobNumber,
    message: `Status updated: ${currentStatus} -> ${newStatus}`,
    warning: warning,
    changesApplied: {
      Current_Status: newStatus,
      Status_Owner: statusOwner,
      Status_Last_Updated: now,
      Last_Updated_By: requestedBy,
      Last_Updated_At: now,
      Last_Update_Operation: op,
    },
    allowedNextStatuses: Array.from(transitions.get(newStatus) || []),
  };

  return logAndReturn_(result, op, jobNumber, p);
}

function setJobField_(p) {
  const op = OPERATIONS.SET_JOB_FIELD;

  const jobNumber = String(p.jobNumber || "").trim();
  const fieldName = String(p.fieldName || "").trim();
  const fieldValue = p.fieldValue;
  const requestedBy = String(p.requestedBy || "").trim();

  if (!jobNumber || !fieldName || !requestedBy) {
    return logAndReturn_(reject_(op, "Missing required inputs (jobNumber/fieldName/requestedBy)", p), op, jobNumber, p);
  }

  const allowed = JOB_FIELD_ALLOWLIST[fieldName];
  if (!allowed || allowed.includes("GATE_ONLY")) {
    return logAndReturn_(reject_(op, `Field not editable via gate: ${fieldName}`, {
      allowedFields: Object.keys(JOB_FIELD_ALLOWLIST).filter(k => !JOB_FIELD_ALLOWLIST[k].includes("GATE_ONLY"))
    }), op, jobNumber, p);
  }

  const jobRef = findRowByKey_(SpreadsheetApp.getActive(), SHEETS.JOBS, JOB_KEY_FIELD, jobNumber);
  if (!jobRef.found) {
    return logAndReturn_(reject_(op, `Job not found: ${jobNumber}`, p), op, jobNumber, p);
  }

  const normalized = normalizeJobFieldValue_(fieldName, fieldValue);
  if (normalized.error) {
    return logAndReturn_(reject_(op, normalized.error, { fieldName, fieldValue }), op, jobNumber, p);
  }

  setCellByHeader_(jobRef.sheet, jobRef.headers, jobRef.rowIndex, fieldName, normalized.value);

  // Stamp update metadata
  const now = new Date();
  stampUpdateMeta_(jobRef.sheet, jobRef.headers, jobRef.rowIndex, requestedBy, now, op);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: jobNumber,
    message: `Field updated: ${fieldName}`,
    changesApplied: {
      [fieldName]: normalized.value,
      Last_Updated_By: requestedBy,
      Last_Updated_At: now,
      Last_Update_Operation: op,
    },
  };

  return logAndReturn_(result, op, jobNumber, p);
}

function createJob_(p) {
  const op = OPERATIONS.CREATE_JOB;

  const requestedBy = String(p.requestedBy || "").trim();
  const jobNumber = String(p.jobNumber || "").trim();

  if (!requestedBy || !jobNumber) {
    return logAndReturn_(reject_(op, "Missing required inputs (requestedBy/jobNumber)", p), op, jobNumber, p);
  }

  // Ensure job doesn't exist
  const existing = findRowByKey_(SpreadsheetApp.getActive(), SHEETS.JOBS, JOB_KEY_FIELD, jobNumber);
  if (existing.found) {
    return logAndReturn_(reject_(op, `Job already exists: ${jobNumber}`, p), op, jobNumber, p);
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.JOBS);
  const headers = getHeaders_(sheet);
  const row = new Array(headers.length).fill("");

  setRowValue_(row, headers, JOB_KEY_FIELD, jobNumber);
  setRowValue_(row, headers, "Customer_Full_Name", String(p.customerFullName || "").trim());
  setRowValue_(row, headers, "Customer_Phone", String(p.customerPhone || "").trim());
  setRowValue_(row, headers, "Customer_Email", String(p.customerEmail || "").trim());
  setRowValue_(row, headers, "Customer_Address", String(p.customerAddress || "").trim());
  setRowValue_(row, headers, "Lead_Source", String(p.leadSource || "").trim());
  setRowValue_(row, headers, "Customer_Type", String(p.customerType || "").trim());
  setRowValue_(row, headers, "Estimator", String(p.estimator || "").trim());

  const now = new Date();
  setRowValue_(row, headers, STATUS_FIELDS.STATUS, "New Lead Received");
  setRowValue_(row, headers, STATUS_FIELDS.OWNER, "Admin");
  setRowValue_(row, headers, STATUS_FIELDS.UPDATED, now);
  setRowValue_(row, headers, STATUS_FIELDS.NOTES, appendNote_("", now, requestedBy, String(p.requestedRole || ""), "Job created."));

  // stamp metadata
  setRowValue_(row, headers, UPDATE_META_FIELDS.BY, requestedBy);
  setRowValue_(row, headers, UPDATE_META_FIELDS.AT, now);
  setRowValue_(row, headers, UPDATE_META_FIELDS.OP, op);

  sheet.appendRow(row);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: jobNumber,
    message: `Job created: ${jobNumber}`,
  };

  return logAndReturn_(result, op, jobNumber, p);
}

/** ====== ITEM MASTER OPS ====== **/

function updateItemCost_(p) {
  const op = OPERATIONS.UPDATE_ITEM_COST;

  const itemCode = String(p.itemCode || "").trim();
  const newUnitCost = p.newUnitCost;
  const costEffectiveDate = p.costEffectiveDate;
  const requestedBy = String(p.requestedBy || "").trim();

  if (!itemCode || isBlank_(newUnitCost) || isBlank_(costEffectiveDate) || !requestedBy) {
    return logAndReturn_(reject_(op, "Missing required inputs (itemCode/newUnitCost/costEffectiveDate/requestedBy)", p), op, itemCode, p);
  }

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const itemRef = findRowByKey_(itemSS, SHEETS.ITEM_MASTER, ITEM_KEY_FIELD, itemCode);
  if (!itemRef.found) {
    return logAndReturn_(reject_(op, `Item not found: ${itemCode}`, p), op, itemCode, p);
  }

  const normalizedCost = Number(newUnitCost);
  if (isNaN(normalizedCost) || normalizedCost <= 0) {
    return logAndReturn_(reject_(op, "newUnitCost must be a number > 0", { newUnitCost }), op, itemCode, p);
  }

  const effDate = tryParseDate_(costEffectiveDate);
  if (!effDate) {
    return logAndReturn_(reject_(op, "Invalid costEffectiveDate", { costEffectiveDate }), op, itemCode, p);
  }

  setCellByHeader_(itemRef.sheet, itemRef.headers, itemRef.rowIndex, "Unit_Cost", normalizedCost);
  setCellByHeader_(itemRef.sheet, itemRef.headers, itemRef.rowIndex, "Cost_Effective_Date", effDate);

  const now = new Date();
  stampUpdateMeta_(itemRef.sheet, itemRef.headers, itemRef.rowIndex, requestedBy, now, op);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: itemCode,
    message: `Item cost updated: ${itemCode}`,
    changesApplied: {
      Unit_Cost: normalizedCost,
      Cost_Effective_Date: effDate,
      Last_Updated_By: requestedBy,
      Last_Updated_At: now,
      Last_Update_Operation: op,
    },
  };

  return logAndReturn_(result, op, itemCode, p);
}

function updateItemField_(p) {
  const op = OPERATIONS.UPDATE_ITEM_FIELD;

  const itemCode = String(p.itemCode || "").trim();
  const fieldName = String(p.fieldName || "").trim();
  const fieldValue = p.fieldValue;
  const requestedBy = String(p.requestedBy || "").trim();

  if (!itemCode || !fieldName || !requestedBy) {
    return logAndReturn_(reject_(op, "Missing required inputs (itemCode/fieldName/requestedBy)", p), op, itemCode, p);
  }

  const allowed = ITEM_FIELD_ALLOWLIST[fieldName];
  if (!allowed || allowed.includes("GATE_ONLY")) {
    return logAndReturn_(reject_(op, `Field not editable via gate: ${fieldName}`, {
      allowedFields: Object.keys(ITEM_FIELD_ALLOWLIST).filter(k => !ITEM_FIELD_ALLOWLIST[k].includes("GATE_ONLY"))
    }), op, itemCode, p);
  }

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const itemRef = findRowByKey_(itemSS, SHEETS.ITEM_MASTER, ITEM_KEY_FIELD, itemCode);
  if (!itemRef.found) {
    return logAndReturn_(reject_(op, `Item not found: ${itemCode}`, p), op, itemCode, p);
  }

  setCellByHeader_(itemRef.sheet, itemRef.headers, itemRef.rowIndex, fieldName, fieldValue);

  const now = new Date();
  stampUpdateMeta_(itemRef.sheet, itemRef.headers, itemRef.rowIndex, requestedBy, now, op);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: itemCode,
    message: `Item field updated: ${itemCode}.${fieldName}`,
    changesApplied: {
      [fieldName]: fieldValue,
      Last_Updated_By: requestedBy,
      Last_Updated_At: now,
      Last_Update_Operation: op,
    },
  };

  return logAndReturn_(result, op, itemCode, p);
}

function createItem_(p) {
  const op = OPERATIONS.CREATE_ITEM;

  const requestedBy = String(p.requestedBy || "").trim();
  const itemCode = String(p.itemCode || "").trim();

  if (!requestedBy || !itemCode) {
    return logAndReturn_(reject_(op, "Missing required inputs (requestedBy/itemCode)", p), op, itemCode, p);
  }

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const itemSheet = itemSS.getSheetByName(SHEETS.ITEM_MASTER);
  const headers = getHeaders_(itemSheet);

  // Ensure item doesn't exist
  const existing = findRowByKey_(itemSS, SHEETS.ITEM_MASTER, ITEM_KEY_FIELD, itemCode);
  if (existing.found) {
    return logAndReturn_(reject_(op, `Item already exists: ${itemCode}`, p), op, itemCode, p);
  }

  // Minimal required fields
  const required = ["itemName","category","unitOfMeasure","unitCost","costEffectiveDate","sourceType","activeStatus"];
  const missing = required.filter(k => isBlank_(p[k]));
  if (missing.length > 0) {
    return logAndReturn_(reject_(op, "Missing required item fields", { missingFields: missing }), op, itemCode, p);
  }

  const row = new Array(headers.length).fill("");

  setRowValue_(row, headers, "Item_Code", itemCode);
  setRowValue_(row, headers, "Item_Name", String(p.itemName || "").trim());
  setRowValue_(row, headers, "Category", String(p.category || "").trim());
  setRowValue_(row, headers, "Unit_of_Measure", String(p.unitOfMeasure || "").trim());
  setRowValue_(row, headers, "Unit_Cost", Number(p.unitCost));
  setRowValue_(row, headers, "Cost_Effective_Date", tryParseDate_(p.costEffectiveDate) || new Date());
  setRowValue_(row, headers, "Vendor_Name", String(p.vendorName || "").trim());
  setRowValue_(row, headers, "Lead_Time", String(p.leadTime || "").trim());
  setRowValue_(row, headers, "Source_Type", String(p.sourceType || "").trim());
  setRowValue_(row, headers, "Default_Usage_Rules", String(p.defaultUsageRules || "").trim());
  setRowValue_(row, headers, "Description", String(p.description || "").trim());
  setRowValue_(row, headers, "Weight_or_Specs", String(p.weightOrSpecs || "").trim());
  setRowValue_(row, headers, "Active_Status", String(p.activeStatus || "").trim());
  setRowValue_(row, headers, "Notes", String(p.notes || "").trim());

  const now = new Date();
  setRowValue_(row, headers, UPDATE_META_FIELDS.BY, requestedBy);
  setRowValue_(row, headers, UPDATE_META_FIELDS.AT, now);
  setRowValue_(row, headers, UPDATE_META_FIELDS.OP, op);

  itemSheet.appendRow(row);

  const result = {
    result: "SUCCESS",
    operation: op,
    targetKey: itemCode,
    message: `Item created: ${itemCode}`,
  };

  return logAndReturn_(result, op, itemCode, p);
}

/** ====== RULE LOADERS (from THIS Job Table spreadsheet) ====== **/

function loadOwnerMap_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.OWNER_MAP);
  const values = sh.getDataRange().getValues();
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    const status = String(values[i][0] || "").trim();
    const owner = String(values[i][1] || "").trim();
    if (status) map.set(status, owner);
  }
  return map;
}

function loadTransitions_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.TRANSITIONS);
  const values = sh.getDataRange().getValues();
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    const from = String(values[i][0] || "").trim();
    const to = String(values[i][1] || "").trim();
    if (!from || !to) continue;
    if (!map.has(from)) map.set(from, new Set());
    map.get(from).add(to);
  }
  return map;
}

function loadRequiredFields_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.REQUIRED);
  const values = sh.getDataRange().getValues();
  const map = new Map();
  for (let i = 1; i < values.length; i++) {
    const status = String(values[i][0] || "").trim();
    const field = String(values[i][1] || "").trim();
    if (!status || !field) continue;
    if (!map.has(status)) map.set(status, new Set());
    map.get(status).add(field);
  }
  return map;
}

/** ====== GENERIC HELPERS ====== **/

function findRowByKey_(spreadsheet, sheetName, keyField, keyValue) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const keyIdx = headers.indexOf(keyField);
  if (keyIdx === -1) return { found: false, sheet, headers, rowIndex: -1, reason: `Key field not found: ${keyField}` };

  for (let i = 1; i < data.length; i++) {
    const v = String(data[i][keyIdx] || "").trim();
    if (v === keyValue) return { found: true, sheet, headers, rowIndex: i + 1 };
  }
  return { found: false, sheet, headers, rowIndex: -1, reason: "Not found" };
}

function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function getCellByHeader_(sheet, headers, rowIndex, headerName) {
  const col = headers.indexOf(headerName);
  if (col === -1) return "";
  return sheet.getRange(rowIndex, col + 1).getValue();
}

function setCellByHeader_(sheet, headers, rowIndex, headerName, value) {
  const col = headers.indexOf(headerName);
  if (col === -1) throw new Error(`Header not found: ${headerName}`);
  sheet.getRange(rowIndex, col + 1).setValue(value);
}

function setRowValue_(rowArr, headers, headerName, value) {
  const idx = headers.indexOf(headerName);
  if (idx === -1) return;
  rowArr[idx] = value;
}

function roleMatchesOwnerSpec_(role, ownerSpec) {
  if (!ownerSpec || !role) return false;
  const parts = String(ownerSpec).split("/").map(s => s.trim());
  return parts.includes(role);
}

function normalizeOwnerForStatus_(ownerSpec, requesterRole) {
  const spec = String(ownerSpec || "").trim();
  if (!spec.includes("/")) return spec || "";
  const parts = spec.split("/").map(s => s.trim());
  if (requesterRole && parts.includes(requesterRole)) return requesterRole;
  return parts[0];
}

function appendNote_(existing, when, userId, role, note) {
  const stamp = Utilities.formatDate(when, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  const line = `[${stamp}] ${userId}${role ? ` (${role})` : ""}: ${note}`;
  return existing ? (existing + "\n" + line) : line;
}

function stampUpdateMeta_(sheet, headers, rowIndex, requestedBy, when, operation) {
  safeSet_(sheet, headers, rowIndex, UPDATE_META_FIELDS.BY, requestedBy);
  safeSet_(sheet, headers, rowIndex, UPDATE_META_FIELDS.AT, when);
  safeSet_(sheet, headers, rowIndex, UPDATE_META_FIELDS.OP, operation);
}

function safeSet_(sheet, headers, rowIndex, headerName, value) {
  const col = headers.indexOf(headerName);
  if (col === -1) return; // don't fail if column not present yet
  sheet.getRange(rowIndex, col + 1).setValue(value);
}

function isBlank_(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function normalizeJobFieldValue_(fieldName, fieldValue) {
  const dateFields = new Set([
    "Quote_Sent_Date","Deposit_Received_Date","Ready_To_Stage_Date",
    "Staging_Complete_Date","Install_Complete_Date","Invoice_Sent_Date","Paid_Date"
  ]);
  const moneyFields = new Set(["Deposit_Amount","Invoice_Amount","Balance_Due"]);

  if (dateFields.has(fieldName)) {
    const d = tryParseDate_(fieldValue);
    if (!d) return { error: `Invalid date for ${fieldName}` };
    return { value: d };
  }
  if (moneyFields.has(fieldName)) {
    const n = Number(fieldValue);
    if (isNaN(n)) return { error: `Invalid number for ${fieldName}` };
    return { value: n };
  }
  if (fieldName === "Job_Closed") {
    if (fieldValue === true || fieldValue === false) return { value: fieldValue };
    const s = String(fieldValue).trim().toUpperCase();
    if (s === "TRUE") return { value: true };
    if (s === "FALSE") return { value: false };
    return { error: "Job_Closed must be TRUE or FALSE" };
  }
  return { value: fieldValue };
}

function tryParseDate_(v) {
  if (v instanceof Date) return v;
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

/** ====== LOGGING ====== **/

function logAndReturn_(resultObj, operation, targetKey, requestPayload) {
  try {
    writeLog_(operation, targetKey, requestPayload, resultObj);
  } catch (e) {
    resultObj.logError = String(e);
  }
  return resultObj;
}

function writeLog_(operation, targetKey, requestPayload, resultObj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.LOG);
  const now = new Date();
  const requestedBy = requestPayload && requestPayload.requestedBy ? requestPayload.requestedBy : "";
  const requestedRole = requestPayload && requestPayload.requestedRole ? requestPayload.requestedRole : "";

  sh.appendRow([
    now,
    requestedBy,
    requestedRole,
    operation,
    operation.startsWith("updateItem") || operation.startsWith("createItem") ? "Item_Master" : SHEETS.JOBS,
    targetKey,
    JSON.stringify(requestPayload || {}),
    resultObj.result || "UNKNOWN",
    (resultObj.result === "REJECTED") ? (resultObj.message || "") : ""
  ]);
}

function reject_(operation, message, extra) {
  return {
    result: "REJECTED",
    operation: operation,
    message: message,
    ...(extra && typeof extra === "object" ? extra : {})
  };
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/******************** READ HANDLERS (TOKEN-PROTECTED) ********************/

function requireReadToken_(p) {
  // Primary: URL querystring (reliable for Apps Script web apps)
  const qsToken = (p && p.__query && p.__query.readToken) ? String(p.__query.readToken) : "";

  // Fallback: body field (works for Colab/manual callers)
  const bodyToken = (p && p.readToken) ? String(p.readToken) : "";

  const provided = String(qsToken || bodyToken || "").trim();
  const expected = String(PropertiesService.getScriptProperties().getProperty("READ_API_TOKEN") || "").trim();

  if (!expected) throw new Error("READ_API_TOKEN is not set in Script Properties.");
  if (!provided || provided !== expected) throw new Error("Unauthorized: missing/invalid read token.");
}

/**
 * getItemCost
 * Input: { operation, itemCode, readToken }
 * Output: Unit_Cost, Cost_Effective_Date, Item_Name (if present), Last_Updated_By/At (if present)
 */
function getItemCost_(p) {
  const op = OPERATIONS.GET_ITEM_COST;
  const itemCode = String(p.itemCode || "").trim();
  if (!itemCode) return reject_(op, "Missing itemCode", p);

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const itemRef = findRowByKey_(itemSS, SHEETS.ITEM_MASTER, ITEM_KEY_FIELD, itemCode);
  if (!itemRef.found) return reject_(op, `Item not found: ${itemCode}`, p);

  const sh = itemRef.sheet, headers = itemRef.headers, row = itemRef.rowIndex;

  return {
    result: "SUCCESS",
    operation: op,
    targetKey: itemCode,
    itemCode: itemCode,
    unitCost: getCellByHeader_(sh, headers, row, "Unit_Cost"),
    costEffectiveDate: getCellByHeader_(sh, headers, row, "Cost_Effective_Date"),
    itemName: getCellByHeader_(sh, headers, row, "Item_Name"),
    lastUpdatedBy: getCellByHeader_(sh, headers, row, "Last_Updated_By"),
    lastUpdatedAt: getCellByHeader_(sh, headers, row, "Last_Updated_At"),
  };
}

/**
 * getItem
 * Input: { operation, itemCode, fields?: [..], readToken }
 * If fields not provided, returns a standard set.
 */
function getItem_(p) {
  const op = OPERATIONS.GET_ITEM;
  const itemCode = String(p.itemCode || "").trim();
  if (!itemCode) return reject_(op, "Missing itemCode", p);

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const itemRef = findRowByKey_(itemSS, SHEETS.ITEM_MASTER, ITEM_KEY_FIELD, itemCode);
  if (!itemRef.found) return reject_(op, `Item not found: ${itemCode}`, p);

  const sh = itemRef.sheet, headers = itemRef.headers, row = itemRef.rowIndex;

  const defaultFields = [
    "Item_Code", "Item_Name", "Category", "Unit_of_Measure",
    "Unit_Cost", "Cost_Effective_Date", "Vendor_Name", "Lead_Time",
    "Source_Type", "Active_Status", "Notes",
    "Last_Updated_By", "Last_Updated_At", "Last_Update_Operation"
  ];

  const fields = Array.isArray(p.fields) && p.fields.length ? p.fields : defaultFields;
  const data = {};

  fields.forEach(f => {
    data[f] = getCellByHeader_(sh, headers, row, f);
  });

  return {
    result: "SUCCESS",
    operation: op,
    targetKey: itemCode,
    itemCode: itemCode,
    data
  };
}

/**
 * getJob
 * Input: { operation, jobNumber, fields?: [..], readToken }
 * If fields not provided, returns a standard set.
 */
function getJob_(p) {
  const op = OPERATIONS.GET_JOB;
  const jobNumber = String(p.jobNumber || "").trim();
  if (!jobNumber) return reject_(op, "Missing jobNumber", p);

  const jobRef = findRowByKey_(SpreadsheetApp.getActive(), SHEETS.JOBS, JOB_KEY_FIELD, jobNumber);
  if (!jobRef.found) return reject_(op, `Job not found: ${jobNumber}`, p);

  const sh = jobRef.sheet, headers = jobRef.headers, row = jobRef.rowIndex;

  const defaultFields = [
    "Job_Number", "Customer_Full_Name", "Customer_Phone", "Customer_Email",
    "Customer_Address", "Lead_Source", "Estimator",
    "Current_Status", "Status_Owner", "Status_Last_Updated", "Status_Notes",
    "Quote_Total", "Invoice_Amount", "Balance_Due", "Invoice_Sent_Date", "Paid_Date",
    "Last_Updated_By", "Last_Updated_At", "Last_Update_Operation"
  ];

  const fields = Array.isArray(p.fields) && p.fields.length ? p.fields : defaultFields;
  const data = {};

  fields.forEach(f => {
    data[f] = getCellByHeader_(sh, headers, row, f);
  });

  return {
    result: "SUCCESS",
    operation: op,
    targetKey: jobNumber,
    jobNumber: jobNumber,
    data
  };
}

/******************** QUOTE PRICING (READ-ONLY) ********************/

function priceQuote_(p) {
  const op = OPERATIONS.PRICE_QUOTE;

  if (!Array.isArray(p.lines) || p.lines.length === 0) {
    return reject_(op, "Missing lines[]", p);
  }

  const itemSS = SpreadsheetApp.openById(ITEM_MASTER_SPREADSHEET_ID);
  const sh = itemSS.getSheetByName(SHEETS.ITEM_MASTER);
  if (!sh) return reject_(op, `Missing sheet: ${SHEETS.ITEM_MASTER}`, p);

  const range = sh.getDataRange().getValues();
  if (range.length < 2) return reject_(op, "Item master is empty", p);

  const headers = range[0].map(h => String(h).trim());
  const idx = (name) => headers.indexOf(name);

  const iCode = idx("Item_Code");
  const iName = idx("Item_Name");
  const iCost = idx("Unit_Cost");
  const iEff  = idx("Cost_Effective_Date");
  const iActive = idx("Active_Status");

  if ([iCode, iName, iCost, iEff].some(x => x === -1)) {
    return reject_(op, "Item master missing required headers (Item_Code, Item_Name, Unit_Cost, Cost_Effective_Date).", { headers });
  }

  const rows = range.slice(1);

  // Build indexes (fast + consistent)
  const byCode = new Map();
  const byNameNorm = new Map(); // exact normalized name -> row
  const nameIndex = []; // for fuzzy search

  rows.forEach(r => {
    const code = String(r[iCode] || "").trim();
    const name = String(r[iName] || "").trim();
    const active = String(iActive !== -1 ? (r[iActive] || "") : "").trim();

    if (code) byCode.set(code.toUpperCase(), r);

    const nn = normalizeText_(name);
    if (nn) {
      // keep first exact name match; if duplicates exist, fuzzy path will handle ambiguity later
      if (!byNameNorm.has(nn)) byNameNorm.set(nn, r);
      nameIndex.push({ code, name, nameNorm: nn, active, row: r });
    }
  });

  const pricedLines = [];
  const needsReview = [];
  let subtotal = 0;

  p.lines.forEach((line, lineNum) => {
    const rawItem = String(line.item || "").trim();
    const qty = Number(line.qty || 0);

    if (!rawItem) {
      needsReview.push({
        lineNum,
        issue: "MISSING_ITEM",
        message: "Line item is blank",
        input: line
      });
      return;
    }

    if (!(qty > 0)) {
      needsReview.push({
        lineNum,
        issue: "INVALID_QTY",
        message: "Qty must be > 0",
        input: line
      });
      return;
    }

    const resolved = resolveItem_(rawItem, { byCode, byNameNorm, nameIndex, iCost, iEff, iActive });

    if (resolved.status === "RESOLVED") {
      const unitCost = Number(resolved.unitCost);
      const extCost = unitCost * qty;
      subtotal += extCost;

      pricedLines.push({
        lineNum,
        inputItem: rawItem,
        resolvedItemCode: resolved.itemCode,
        resolvedItemName: resolved.itemName,
        qty,
        unitCost,
        costEffectiveDate: resolved.costEffectiveDate || "",
        extCost
      });
      return;
    }

    // Ambiguous or not found → no auto-pick (Option A)
    needsReview.push({
      lineNum,
      issue: resolved.status,
      message: resolved.message,
      inputItem: rawItem,
      candidates: resolved.candidates || []
    });
  });

  const resultStatus = needsReview.length ? "REVIEW_REQUIRED" : "SUCCESS";

  return {
    result: resultStatus,
    operation: op,
    totals: {
      subtotal
    },
    pricedLines,
    needsReview
  };
}

function resolveItem_(rawItem, ctx) {
  const input = String(rawItem || "").trim();
  const upper = input.toUpperCase();
  const norm = normalizeText_(input);

  // 1) Exact Item_Code
  if (ctx.byCode.has(upper)) {
    const r = ctx.byCode.get(upper);
    return resolvedFromRow_(r, ctx);
  }

  // 2) Exact normalized Item_Name
  if (norm && ctx.byNameNorm.has(norm)) {
    const r = ctx.byNameNorm.get(norm);
    return resolvedFromRow_(r, ctx);
  }

  // 3) Fuzzy contains match on normalized name (no auto-pick)
  if (!norm) {
    return { status: "NOT_FOUND", message: "Empty/invalid item input after normalization." };
  }

  const candidates = ctx.nameIndex
    .filter(x => x.nameNorm.includes(norm) || norm.includes(x.nameNorm))
    .map(x => {
      const unitCost = Number(x.row[ctx.iCost]);
      const eff = x.row[ctx.iEff];
      const active = String(ctx.iActive !== -1 ? (x.row[ctx.iActive] || "") : x.active || "").trim();
      const score = scoreMatch_(norm, x.nameNorm);

      return {
        itemCode: String(x.code || "").trim(),
        itemName: String(x.name || "").trim(),
        unitCost: isFinite(unitCost) ? unitCost : "",
        costEffectiveDate: eff || "",
        activeStatus: active,
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (candidates.length === 0) {
    return { status: "NOT_FOUND", message: `No matches found for: ${input}` };
  }

  // If there's exactly one candidate and it's clearly dominant, we STILL do not auto-pick (Option A).
  return {
    status: "AMBIGUOUS",
    message: `Multiple possible matches for: ${input}. Please choose one.`,
    candidates
  };
}

function resolvedFromRow_(r, ctx) {
  const itemCode = String(r[0] || "").trim(); // may not be col0; safer to re-pull by headers would be more code
  // Better: attempt to find via known headers when possible
  // We'll infer via map usage: for code we already had code; for name we should include name.
  // So we rebuild from row using common headers if they exist.
  const itemName = ""; // will be filled below if possible

  // Since we don't have header indices here for code/name, we fallback to search by known headers
  // (This stays robust to column order)
  const shTemp = null;

  const unitCost = Number(r[ctx.iCost]);
  const costEffectiveDate = r[ctx.iEff];

  // Try to locate Item_Code / Item_Name via ctx.nameIndex entry (best effort)
  let code = "";
  let name = "";
  for (const x of ctx.nameIndex) {
    if (x.row === r) { code = x.code; name = x.name; break; }
  }

  return {
    status: "RESOLVED",
    itemCode: String(code || "").trim(),
    itemName: String(name || "").trim(),
    unitCost: isFinite(unitCost) ? unitCost : "",
    costEffectiveDate: costEffectiveDate || ""
  };
}

function normalizeText_(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/–/g, "-")
    .replace(/[^\w\s-]/g, "")   // drop punctuation
    .replace(/\s+/g, " ");      // collapse spaces
}

function scoreMatch_(needle, haystack) {
  // Simple scoring: exact > prefix > contains
  if (needle === haystack) return 100;
  if (haystack.startsWith(needle)) return 80;
  if (haystack.includes(needle)) return 60;
  if (needle.includes(haystack)) return 40;
  return 0;
}
/**
 * === MAPLE Bridge Connection Test ===
 * Simple endpoint to confirm ChatGPT → Apps Script connectivity.
 * Input:  { test: "ping" }
 * Output: { status: "ok", received: {...} }
 */
function doGet(e) {
  // Accept either GET query params or POST data for testing
  const payload = e && e.parameter ? e.parameter : {};
  return ContentService
    .createTextOutput(
      JSON.stringify({ status: "ok", received: payload, note: "Bridge reachable." })
    )
    .setMimeType(ContentService.MimeType.JSON);
}
