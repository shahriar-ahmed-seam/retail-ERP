# Requirements Document

## Introduction

Core Retail ERP V1 is a single-tenant desktop application for a hardware shop, built on Electron, React, TypeScript, SQLite, and Prisma. The application supports both online and offline operation on a local workstation and bundles point-of-sale, inventory, purchasing, supplier, customer, reporting, and backup capabilities into a single installer.

The V1 success criterion is that a real hardware shop can run one full business day on this software, with no inventory corruption, fast checkout, and recoverable data. The application must also remain responsive as the database grows into the millions of rows over years of operation, and must install on any supported desktop machine without requiring the user to install or configure separate database software.

This document specifies functional requirements per module, non-functional requirements (reliability, performance, auditability, data safety, large-database efficiency, usability), and an explicit out-of-scope section enumerating capabilities deferred beyond V1.

## Glossary

- **System**: The Core Retail ERP V1 desktop application as a whole.
- **Auth_System**: The authentication and session subsystem responsible for login, password hashing, and session lifecycle.
- **Permission_System**: The role-based access control subsystem that authorizes actions based on the active user's role.
- **Product_Manager**: The subsystem that manages product, category, pricing, tax, warranty, and SKU records.
- **Inventory_System**: The subsystem that tracks current stock levels and records every stock-changing event in the inventory movements ledger.
- **POS_System**: The point-of-sale subsystem that drives checkout, cart, payment capture, and receipt printing.
- **Purchase_System**: The subsystem that records supplier purchase invoices and increases inventory upon receipt.
- **Supplier_Manager**: The subsystem that manages supplier master data and exposes per-supplier purchase history.
- **Customer_Manager**: The subsystem that manages customer master data and exposes per-customer purchase history.
- **Reports_Module**: The subsystem that produces daily sales, monthly sales, low-stock, and top-selling reports with CSV and PDF export.
- **Backup_System**: The subsystem that creates scheduled and on-demand snapshots of the SQLite database and maintains the append-only transaction journal.
- **Audit_Log**: An append-only record of sensitive operations stored in the `audit_logs` table.
- **Inventory_Movement**: A row in the `inventory_movements` ledger representing a single stock change with type, quantity, reference, and timestamp.
- **Transaction_Journal**: An append-only log of business transactions stored in the `journal_entries` table, used for replay after corruption.
- **Reorder_Level**: A per-product integer threshold defined on the product record; stock at or below this value is classified as low.
- **Serial_No**: A monotonically increasing per-shop identifier assigned to each sale invoice in the format `INV-XXXXXX`.
- **Admin**: A role with full access to administrative functions including pricing, roles, settings, and reports.
- **Cashier**: A role limited to POS operations and read-only access to product and customer data.
- **Receipt_Printer**: The configured ESC/POS thermal printer used as the primary receipt output.
- **HTML_Fallback_Printer**: The Electron `webContents.print()` HTML/PDF receipt path used when ESC/POS printing is unavailable.
- **Page_Size**: The maximum number of rows returned by a single list endpoint request; the default Page_Size is 50 rows and the maximum permitted Page_Size is 200 rows.
- **Cursor**: An opaque token encoding a position in an ordered result set (typically a `(timestamp, id)` or `(created_at, id)` pair) used to fetch the next page of a list query without re-scanning skipped rows.
- **WAL_Checkpoint**: A SQLite operation that transfers committed pages from the write-ahead log file back into the main database file, bounding WAL file growth under sustained write load.
- **Process_RSS**: The resident set size of the Electron main process measured in megabytes, used as the memory budget for streaming exports and journal replay.
- **Covering_Index**: A SQLite index that includes every column referenced by a query's `WHERE`, `ORDER BY`, and `JOIN` clauses, allowing the query to be served from the index without touching the underlying table rows.
- **Bundled_SQLite**: The SQLite engine compiled into the application installer (e.g., the `better-sqlite3` native binary or the Prisma bundled query engine), eliminating any separate database server installation on the target machine.

## Requirements

### Requirement 1: Authentication

**User Story:** As a shop owner, I want users to authenticate with a username and password before using the application, so that only authorized staff can operate the system.

#### Acceptance Criteria

1. WHEN a user submits valid credentials on the login screen, THE Auth_System SHALL establish an authenticated session bound to the user's role.
2. IF a user submits invalid credentials, THEN THE Auth_System SHALL reject the login attempt and SHALL display an authentication error.
3. THE Auth_System SHALL store user passwords as salted bcrypt hashes and SHALL NOT store plaintext passwords.
4. WHEN a user logs out or the application is closed, THE Auth_System SHALL terminate the active session.
5. WHILE no session is active, THE System SHALL restrict access to all modules other than the login screen.
6. WHEN the Auth_System is initialized for the first time on a fresh installation, THE Auth_System SHALL require creation of an initial Admin account before granting access to other modules.

### Requirement 2: Product Management

**User Story:** As an Admin, I want to manage the product catalog with pricing, tax, and warranty information, so that the POS and inventory subsystems share a single source of truth.

#### Acceptance Criteria

1. THE Product_Manager SHALL persist each product with the fields `sku`, `name`, `category_id`, `barcode`, `buy_price`, `sell_price`, `tax_rate`, `warranty_months`, and `reorder_level`.
2. WHEN an Admin creates a product, THE Product_Manager SHALL require a unique `sku` and SHALL reject creation if the `sku` already exists.
3. WHEN an Admin assigns a `barcode` to a product, THE Product_Manager SHALL require the `barcode` to be unique across all products.
4. WHEN an Admin updates `buy_price` or `sell_price`, THE Product_Manager SHALL record the change in the Audit_Log with the previous value, new value, user, and timestamp.
5. THE Product_Manager SHALL allow categorization of products under categories managed in the `categories` table.
6. WHERE a product has `tax_rate` set to a non-zero value, THE POS_System SHALL apply that rate when calculating the tax line on sales containing that product.

### Requirement 3: Inventory System

**User Story:** As a shop owner, I want every stock change tracked in a movements ledger and to be alerted when stock is low, so that on-hand quantities are always reconcilable and stock-outs are prevented.

#### Acceptance Criteria

1. WHEN any operation increases or decreases on-hand stock for a product, THE Inventory_System SHALL append exactly one Inventory_Movement to the `inventory_movements` ledger with `product_id`, `quantity_delta`, `movement_type`, `reference_type`, `reference_id`, `user_id`, and `timestamp`.
2. THE Inventory_System SHALL compute and persist current on-hand quantity per product such that the sum of all `quantity_delta` values for a product equals that product's current on-hand quantity.
3. WHEN a sale is finalized, THE Inventory_System SHALL decrement on-hand stock for each line item atomically with the sale record.
4. WHEN a purchase invoice is received, THE Inventory_System SHALL increment on-hand stock for each line item atomically with the purchase record.
5. WHEN an Admin records a manual stock adjustment, THE Inventory_System SHALL append an Inventory_Movement of type `adjustment` and SHALL record the adjustment in the Audit_Log.
6. WHILE a product's on-hand quantity is at or below the product's `reorder_level`, THE Inventory_System SHALL classify the product as low-stock and SHALL include the product in the in-app low-stock banner and the daily low-stock summary export.
7. IF a sale would reduce on-hand stock below zero, THEN THE Inventory_System SHALL reject the sale and SHALL surface an out-of-stock error to the POS_System.

### Requirement 4: POS System

**User Story:** As a Cashier, I want to scan items, accept payment, and print a receipt quickly, so that customer checkout is fast and accurate.

#### Acceptance Criteria

1. WHEN a Cashier scans a barcode that matches a product, THE POS_System SHALL add one unit of that product to the active cart within 200 milliseconds of the scan input.
2. WHEN a Cashier finalizes a sale, THE POS_System SHALL persist the sale, sale items, payment records, and Inventory_Movement entries within a single database transaction and SHALL complete the operation within 500 milliseconds under a catalog of up to 10,000 products.
3. THE POS_System SHALL assign each finalized sale a Serial_No in the format `INV-XXXXXX` that is monotonically increasing and unique per shop.
4. THE POS_System SHALL compute the receipt totals as line subtotal, tax line, discount line, and grand total, and SHALL persist each component on the sale record.
5. WHEN a Cashier applies a discount, THE POS_System SHALL accept either a fixed-amount or a percentage discount and SHALL recalculate the tax line from the post-discount subtotal.
6. THE POS_System SHALL accept the payment methods `cash`, `card`, and `mobile` and SHALL allow a single sale to be split across multiple payment methods such that the sum of payments equals the grand total.
7. WHEN a sale is finalized, THE POS_System SHALL print the receipt to the Receipt_Printer using ESC/POS commands.
8. IF the Receipt_Printer is unavailable or the ESC/POS print attempt fails, THEN THE POS_System SHALL fall back to the HTML_Fallback_Printer and SHALL produce an HTML or PDF receipt for the same sale.
9. IF the database transaction for a sale fails at any step, THEN THE POS_System SHALL roll back all sale, payment, and Inventory_Movement changes and SHALL surface a failure message to the Cashier.

### Requirement 5: Purchase System

**User Story:** As an Admin, I want to record purchase invoices from suppliers and have stock received atomically, so that purchasing increases inventory without manual reconciliation.

#### Acceptance Criteria

1. WHEN an Admin records a purchase invoice, THE Purchase_System SHALL persist the purchase header, purchase line items, and Inventory_Movement entries within a single database transaction.
2. THE Purchase_System SHALL associate each purchase with a supplier from the `suppliers` table.
3. THE Purchase_System SHALL persist each purchase line item with `product_id`, `quantity`, `unit_buy_price`, and computed `line_total`.
4. WHEN a purchase is saved, THE Inventory_System SHALL increment on-hand stock for each line item by the corresponding `quantity`.
5. IF the database transaction for a purchase fails at any step, THEN THE Purchase_System SHALL roll back the purchase header, line items, and Inventory_Movement changes.

### Requirement 6: Supplier Management

**User Story:** As an Admin, I want to maintain supplier records and view their purchase history, so that I can manage supplier relationships and reorder from prior vendors.

#### Acceptance Criteria

1. THE Supplier_Manager SHALL persist each supplier with the fields `name`, `phone`, and `address`.
2. THE Supplier_Manager SHALL provide a list view of all suppliers ordered by `name`.
3. WHEN an Admin opens a supplier detail view, THE Supplier_Manager SHALL display the supplier's purchase history sourced from the `purchases` table, ordered by purchase date descending.

### Requirement 7: Customer Management

**User Story:** As a Cashier, I want to attach a customer to a sale and view that customer's prior purchases, so that I can support repeat customers and basic warranty lookups.

#### Acceptance Criteria

1. THE Customer_Manager SHALL persist each customer with the fields `name` and `phone`.
2. WHEN a Cashier attaches a customer to a sale, THE POS_System SHALL persist the customer reference on the sale record.
3. WHEN a user opens a customer detail view, THE Customer_Manager SHALL display the customer's sale history sourced from the `sales` table, ordered by sale date descending.
4. WHERE no customer is attached to a sale, THE POS_System SHALL persist the sale as a walk-in sale without a customer reference.

### Requirement 8: Roles & Permissions

**User Story:** As a shop owner, I want distinct Admin and Cashier roles with enforced permissions, so that cashiers cannot change prices, roles, or settings.

#### Acceptance Criteria

1. THE Permission_System SHALL define at minimum the roles `Admin` and `Cashier`.
2. WHILE the active session has the `Admin` role, THE Permission_System SHALL grant access to product pricing, role assignment, settings, manual stock adjustments, and reports.
3. WHILE the active session has the `Cashier` role, THE Permission_System SHALL grant access to the POS_System and read-only access to the Product_Manager and Customer_Manager, and SHALL deny access to pricing edits, role assignment, manual stock adjustments, and settings.
4. IF a user with the `Cashier` role attempts an action restricted to `Admin`, THEN THE Permission_System SHALL deny the action and SHALL record the denial in the Audit_Log.
5. WHEN an Admin changes another user's role, THE Permission_System SHALL record the change in the Audit_Log with the previous role, new role, acting user, target user, and timestamp.

### Requirement 9: Reports

**User Story:** As an Admin, I want daily sales, monthly sales, low-stock, and top-selling reports with CSV and PDF export, so that I can review business performance and stock health.

#### Acceptance Criteria

1. WHEN an Admin requests the daily sales report for a given date, THE Reports_Module SHALL produce a report containing total sales count, total revenue, total tax collected, total discounts, and a per-payment-method breakdown for that date.
2. WHEN an Admin requests the monthly sales report for a given month, THE Reports_Module SHALL produce a report containing total sales count, total revenue, total tax collected, and total discounts for that month.
3. WHEN an Admin requests the low-stock summary, THE Reports_Module SHALL include every product whose current on-hand quantity is at or below that product's `reorder_level`, with columns `sku`, `name`, `on_hand`, and `reorder_level`.
4. WHEN an Admin requests the top-selling items report for a given date range, THE Reports_Module SHALL list products ordered by total units sold descending within that range.
5. WHEN an Admin invokes export on any report, THE Reports_Module SHALL produce both a CSV file and a PDF file of the same report data.

### Requirement 10: Backup System

**User Story:** As a shop owner, I want automatic local backups and a transaction journal, so that the shop's data can be recovered after disk failure or database corruption.

#### Acceptance Criteria

1. THE Backup_System SHALL create a scheduled snapshot of `shop.db` into the `backups/` folder once per calendar day.
2. WHEN an Admin clicks the "Backup now" control, THE Backup_System SHALL create an on-demand snapshot of `shop.db` into the `backups/` folder.
3. THE Backup_System SHALL retain at least the most recent 14 daily snapshots and SHALL delete snapshots older than the configured retention window.
4. WHEN any business transaction (sale, purchase, manual stock adjustment, price change, role change) is committed, THE Backup_System SHALL append a corresponding entry to the Transaction_Journal in the `journal_entries` table.
5. THE Transaction_Journal SHALL be append-only and SHALL NOT permit update or delete of existing entries through the application.
6. WHERE a database corruption is detected on startup, THE Backup_System SHALL offer the Admin a recovery path that restores the most recent snapshot and replays Transaction_Journal entries committed after that snapshot.

### Requirement 11: Reliability and Atomicity

**User Story:** As a shop owner, I want sales and purchases to either complete fully or not at all, so that inventory never becomes corrupted under concurrent or interrupted operations.

#### Acceptance Criteria

1. THE System SHALL execute each sale as a single SQLite transaction covering the sale header, sale items, payments, and Inventory_Movement entries.
2. THE System SHALL execute each purchase as a single SQLite transaction covering the purchase header, purchase items, and Inventory_Movement entries.
3. IF the application is terminated mid-transaction, THEN on next startup THE System SHALL ensure no partially committed sale or purchase is visible in the database.
4. THE Inventory_System SHALL reconcile such that for every product the current on-hand quantity equals the sum of `quantity_delta` values in `inventory_movements` for that product.

### Requirement 12: Performance

**User Story:** As a Cashier and shop owner, I want barcode scans, sale finalization, and historical data browsing to feel instant even after years of accumulated transactions, so that checkout lines move quickly and reporting stays usable as the database grows.

#### Acceptance Criteria

1. WHEN a barcode scan event is received by the POS_System, THE POS_System SHALL add the matching product to the active cart within 200 milliseconds.
2. WHEN the Cashier confirms payment, THE POS_System SHALL persist the sale and print the receipt within 500 milliseconds, measured from confirmation to receipt dispatch, with a product catalog of up to 10,000 products.
3. THE 10,000-product benchmark in criteria 1 and 2 SHALL apply to first-page list operations and barcode scan against the active product catalog.
4. WHILE the historical tables `sales`, `inventory_movements`, `journal_entries`, and `audit_logs` each contain up to 1,000,000 rows, THE System SHALL remain interactive for paginated, filtered, and sorted access to those tables, where "interactive" is defined in Requirement 16 as a p95 first-page list response within 100 milliseconds on indexed columns.

### Requirement 13: Auditability

**User Story:** As an Admin, I want sensitive operations recorded in an audit log, so that I can review who changed prices, roles, or stock adjustments and when.

#### Acceptance Criteria

1. WHEN an Admin changes a product's `buy_price` or `sell_price`, THE System SHALL append an Audit_Log entry containing `action_type`, `entity_id`, previous value, new value, `user_id`, and `timestamp`.
2. WHEN an Admin changes a user's role, THE System SHALL append an Audit_Log entry containing previous role, new role, acting `user_id`, target `user_id`, and `timestamp`.
3. WHEN an Admin records a manual stock adjustment, THE System SHALL append an Audit_Log entry containing `product_id`, `quantity_delta`, reason text, `user_id`, and `timestamp`.
4. THE Audit_Log SHALL be append-only and SHALL NOT permit update or delete of existing entries through the application.

### Requirement 14: Installation and Usability

**User Story:** As a non-technical shop owner, I want a single installer that drops a fully working application onto any supported desktop with no separate database setup, so that I can adopt the software without IT support.

#### Acceptance Criteria

1. THE System SHALL be distributed as a single Electron installer per supported desktop operating system that installs the application, the Bundled_SQLite engine, and the Prisma client without additional manual steps.
2. WHEN the installer completes on a machine with no prior installation, THE System SHALL launch to the initial Admin setup screen described in Requirement 1.
3. THE POS_System SHALL expose checkout, barcode entry, payment, and receipt printing on a single screen reachable within one click from the application home.
4. THE System SHALL operate without an internet connection for all V1 modules.
5. THE installer SHALL embed the Bundled_SQLite engine such that no separate database server, ODBC driver, or external runtime dependency is required on the target machine.
6. THE System SHALL operate on the target machine without requiring the user to install Node.js, the Prisma CLI, the SQLite CLI, or any database management tool.
7. THE installer SHALL produce a fully self-contained application binary whose only operating-system-level prerequisite is the supported desktop operating system itself.
8. WHEN the application is launched for the first time after installation, THE System SHALL create the database file at `<userData>/shop.db` automatically with no manual configuration.
9. THE installer SHALL include all required Prisma migrations, and WHEN the application is launched, THE System SHALL execute pending migrations before granting access to any module other than the migration progress screen.

### Requirement 15: Data Model

**User Story:** As a developer, I want the V1 database schema fixed and indexed for both correctness and large-database performance, so that all modules share a consistent, scalable data foundation.

#### Acceptance Criteria

1. THE System SHALL persist data in a SQLite database accessed through Prisma using the tables `users`, `roles`, `products`, `categories`, `inventory`, `inventory_movements`, `customers`, `suppliers`, `purchases`, `purchase_items`, `sales`, `sale_items`, `payments`, `settings`, `audit_logs`, and `journal_entries`.
2. THE System SHALL enforce referential integrity between `sale_items` and `products`, `sale_items` and `sales`, `payments` and `sales`, `purchase_items` and `products`, `purchase_items` and `purchases`, `purchases` and `suppliers`, `inventory_movements` and `products`, and `sales` and `customers` where a customer is attached.
3. THE System SHALL define a Covering_Index on every column used as a list filter, list sort key, or join target, including the columns enumerated in Requirement 16.
4. THE System SHALL support Cursor-based pagination via composite indexes, including `(created_at DESC, id)` on the `sales` table and `(timestamp DESC, id)` on the `journal_entries`, `inventory_movements`, and `audit_logs` tables, such that fetching the next page is an indexed seek rather than an offset scan.

### Requirement 16: Large-Database Efficiency

**User Story:** As a shop owner running this application for several years, I want list views, exports, backups, and recovery to stay fast and memory-bounded as the database grows past one million rows, so that the application does not slow down or run out of memory over time.

#### Acceptance Criteria

1. WHEN a list endpoint is requested for any of `products`, `customers`, `suppliers`, `sales`, `purchases`, `inventory_movements`, `audit_logs`, or `journal_entries`, THE System SHALL return at most Page_Size rows per response, where the default Page_Size is 50 rows and the maximum permitted Page_Size is 200 rows.
2. WHERE a list endpoint request includes a total-count flag, THE System SHALL return total row count as a separate field on the response and SHALL omit total count from page responses that do not request it.
3. THE System SHALL execute search, filter, and sort operations for list views as SQL queries in the main process and SHALL transmit only the resulting page to the renderer process.
4. THE System SHALL maintain a SQLite index on every column used as a list filter or list sort key, including `products.sku`, `products.barcode`, `customers.phone`, `suppliers.name`, `sales.serial_no`, `sales.created_at`, `inventory_movements.product_id`, `inventory_movements.timestamp`, `journal_entries.timestamp`, `audit_logs.timestamp`, and `audit_logs.action_type`.
5. WHERE a renderer table view can display more than 200 rows for a given dataset, THE System SHALL render the table using row virtualization (e.g., `react-window`) such that the number of mounted DOM rows remains bounded regardless of the underlying dataset size.
6. WHEN an Admin invokes CSV or PDF export from the Reports_Module, THE Reports_Module SHALL stream rows to the output file rather than buffering the full result set in memory, and SHALL complete export of a 1,000,000-row dataset while keeping Process_RSS at or below 200 megabytes.
7. THE Backup_System SHALL produce database snapshots using SQLite's `VACUUM INTO` streaming mechanism such that snapshot creation memory usage is bounded by SQLite's page-level streaming rather than by the full database size.
8. WHEN the Backup_System replays the Transaction_Journal during recovery, THE Backup_System SHALL process journal entries in batches of at most 1,000 entries per batch rather than loading the full journal into memory.
9. WHILE the `sales` table contains 1,000,000 rows, THE System SHALL return the first page of any paginated list endpoint that filters or sorts on an indexed column within a p95 latency of 100 milliseconds.
10. THE System SHALL execute SQLite `VACUUM` and `ANALYZE` maintenance at least once per calendar week to keep query plans and free-page reuse current as data grows.
11. THE System SHALL perform a WAL_Checkpoint after at most 1,000 committed write transactions or after at most 60 minutes of elapsed time, whichever occurs first, such that the SQLite WAL file size remains bounded under sustained write load.

## Out of Scope (V1 Exclusions)

The following capabilities are explicitly out of scope for V1 and SHALL NOT be implemented in this release:

- Double-entry accounting and general ledger (GL)
- Balance sheets, profit-and-loss statements, and other accounting financial statements
- Tax filing, tax return generation, and statutory tax reporting
- Payroll and employee compensation management
- Warranty engine (the system stores `warranty_months` on products only; claims tracking, RMA workflows, and warranty expiry alerts are out of scope)
- Delivery management, dispatch, and shipping
- Cloud sync, multi-device replication, and remote backup
- Ecommerce storefront and online customer-facing ordering
- Multi-branch and multi-tenant operation (V1 is single-shop, single-tenant)
- AI features, demand forecasting, and predictive reordering
- Auto-generated draft purchase orders from low-stock conditions (low-stock surfaces only as in-app banner and exportable summary)
