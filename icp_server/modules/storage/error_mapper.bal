// Copyright (c) 2025, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
//
// WSO2 Inc. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//  http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import ballerina/sql;

// Category of a database error, determined by inspecting the raw sql:Error
// message. Call sites use this to select a domain-specific, user-friendly
// message without the classifier needing to know about any entity.
enum SqlErrorCategory {
    DUPLICATE_KEY,
    VALUE_TOO_LONG,
    FOREIGN_KEY_VIOLATION,
    MISSING_SCHEMA_OBJECT,
    UNKNOWN_SQL_ERROR
}

// Classifies a raw sql:Error into a high-level category by inspecting
// the error message for well-known database error patterns
// (PostgreSQL, MySQL, MSSQL, Oracle).
//
// The classifier has NO knowledge of entities, constraint names, or
// user-facing messages — that belongs to the call site.
isolated function classifySqlError(sql:Error err) returns SqlErrorCategory {
    string msg = err.message().toLowerAscii();

    // "duplicate key" / "duplicate entry"  — MySQL, MSSQL, PostgreSQL
    // "unique constraint" / "unique_violation"  — PostgreSQL
    // "unique index or primary key violation"   — H2 (used in tests and local dev)
    // "ora-00001" ("unique constraint ... violated") — Oracle
    if msg.includes("duplicate key") || msg.includes("duplicate entry") ||
            msg.includes("unique constraint") || msg.includes("unique_violation") ||
            msg.includes("unique index or primary key violation") ||
            msg.includes("ora-00001") {
        return DUPLICATE_KEY;
    }

    // "ora-12899" ("value too large for column") — Oracle
    if msg.includes("value too long") || msg.includes("data too long") ||
            msg.includes("string or binary data would be truncated") ||
            msg.includes("value too large") || msg.includes("ora-12899") {
        return VALUE_TOO_LONG;
    }

    // "ora-02291" (parent key not found) / "ora-02292" (child record found) — Oracle
    if msg.includes("foreign key") || msg.includes("violates foreign key") ||
            msg.includes("ora-02291") || msg.includes("ora-02292") {
        return FOREIGN_KEY_VIOLATION;
    }

    // A table or view the query depends on does not exist. In practice this means a
    // pending schema migration rather than a bad request, so call sites should say so.
    // "table ... not found"           — H2
    // "doesn't exist"                 — MySQL / MariaDB
    // "relation ... does not exist"   — PostgreSQL
    // "invalid object name"           — MSSQL
    // "ora-00942" ("table or view does not exist") — Oracle
    if (msg.includes("table") && msg.includes("not found")) ||
            msg.includes("doesn't exist") || msg.includes("does not exist") ||
            msg.includes("invalid object name") || msg.includes("ora-00942") {
        return MISSING_SCHEMA_OBJECT;
    }

    return UNKNOWN_SQL_ERROR;
}
