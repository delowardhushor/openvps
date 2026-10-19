# Databases (MongoDB browser)

The **Databases** page lets you look at your MongoDB data from the panel, a bit like MongoDB
Compass: pick a database and a collection, filter and sort documents, page through them, and see
indexes and sizes. It is **read-only**: nothing you do here changes your data.

## Connect

1. **Databases → Add connection** (or **Use MongoDB on this server** for `mongodb://127.0.0.1:27017`).
2. Paste a connection string, press **Test connection**, then **Add connection**.

Examples:

```
mongodb://127.0.0.1:27017
mongodb://admin:p%40ssword@127.0.0.1:27017/?authSource=admin
mongodb+srv://user:password@cluster0.abcde.mongodb.net/
mongodb://user:password@db.example.com:27017/mydb?tls=true
```

- Percent-encode special characters in the user name and password (`@` → `%40`, `:` → `%3A`).
- `mongodb+srv://` (Atlas) and replica-set strings work; OpenVPS reads from the first reachable
  member and accepts reads from a secondary.
- Logins use user name and password (SCRAM-SHA-256 or SCRAM-SHA-1). Client certificates, LDAP,
  Kerberos and AWS IAM logins are not supported. `tls=true` is supported; custom CA files are not
  (`tlsAllowInvalidCertificates=true` works but turns off certificate checking: avoid it).
- MongoDB 3.6 or newer.
- The connection string, password included, is stored encrypted and is never sent back to the
  browser. When you edit a connection, leave the string blank to keep the stored one.
- A user that may only read one database works: OpenVPS shows the databases and collections that
  user is allowed to see. Give the panel a **read-only** MongoDB user (role `read`, or
  `readAnyDatabase`) so that it cannot change anything even if there were a bug.

If MongoDB is not installed on this server, `sudo openvps provision` installs it (see
[Backups](backups.md#before-you-start)). A fresh install listens on `127.0.0.1` only and has no users.

## Browse

- The left tree lists databases (with size) and their collections. System collections are hidden
  unless you tick **Show system collections**.
- **Documents** shows 20, 50 or 100 per page with the total, timing and Prev/Next. **List** shows
  each document as a tree with colour-coded types (ObjectId, Date, Int32, Int64, Double,
  Decimal128, UUID, Binary...); **Table** shows one row per document. **Copy JSON** copies one
  document as Extended JSON.
- **Indexes & size** shows document count, data and index sizes and every index (keys, unique,
  sparse, TTL, partial).

### Filter, sort and project

Type queries the way you would in Compass or the shell. Quotes around keys are optional, single
quotes work, trailing commas are fine, and these helpers are understood:

```
{ status: "active" }
{ age: { $gt: 30 }, city: /^dha/i }
{ _id: ObjectId("507f1f77bcf86cd799439011") }
{ createdAt: { $gte: ISODate("2024-01-01") } }
{ id: UUID("01234567-89ab-cdef-0123-456789abcdef") }
{ big: NumberLong("9007199254740993") }
```

Extended JSON (`{"$oid": "..."}`, `{"$date": "..."}`) also works. **Options** adds *Sort*
(`{ createdAt: -1 }`), *Project* (`{ name: 1, email: 1 }`) and the page size. Mistakes are shown
under the box with the position. Plain numbers match Int32, Int64, Double and Decimal128 values
by value; Decimal128 values cannot be typed into a filter.

## Limits and safety

- Queries stop after 15 seconds, counting after 5 (the total then shows as unknown). A page is at
  most 100 documents. Very long strings and binary values are cut in the display and marked.
- `$where`, `$function` and `$accumulator` (JavaScript run by the server) are refused.
- Only these MongoDB commands are ever sent: `isMaster`, the login steps, `buildInfo`,
  `listDatabases`, `listCollections`, `aggregate` with `$collStats`, `listIndexes`, `find` (plus `killCursors` to close its cursor) and
  `count`.
- Opening and querying are not written to the activity log one by one; adding, editing and
  removing connections are.
- The panel connects to MongoDB itself, not through the root agent, so browsing needs no extra
  privileges. It can reach whatever the server can reach, including internal addresses: only
  give panel access to people you would trust with that.

## Not included (yet)

Editing, inserting and deleting documents, aggregation pipelines, index management, schema
analysis, and exporting results.

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `Authentication failed` | Wrong user, password or authentication database. Add `?authSource=admin` if the user was created in `admin` |
| `Cannot connect to host:port: ECONNREFUSED` | MongoDB is not running or not listening there: `systemctl status mongod` |
| `... ETIMEDOUT` / `timed out` | Firewall or wrong address (Atlas needs this server's IP on its access list) |
| `not allowed` | The MongoDB user lacks the rights for that database; give it the `read` role |
| `The query took too long` | Add a more selective filter, or sort on an indexed field |
| `Authentication mechanism ... not supported` | Use a user name and password (SCRAM) connection |
