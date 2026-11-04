import { createQuery, describeError, isNotStarted } from "../server/amp.ts"
const q = createQuery(process.env.AMP_QUERY_URL!, process.env.AMP_QUERY_TOKEN)
for (const ds of ["benface/pricetag_scratch@0.0.4", process.env.PRICETAG_DATASET!]) {
  for (const sql of [`SELECT block_num FROM "${ds}".unlisted_moves WHERE block_num BETWEEN 53515446 AND 53515446 LIMIT 1`, `SELECT block_num FROM "${ds}".unlisted_moves LIMIT 1`]) {
    try { const r = await q<any>(sql, 30000); console.log(ds, "OK rows", r.length) } catch (e) { console.log(ds, "ERR notStarted=", isNotStarted(e), describeError(e).slice(0,140)) }
  }
}
process.exit(0)
