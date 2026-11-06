// Prints the last block Amp has finished in a table, or nothing if it hasn't started. For `scripts/amp`.
//   node scripts/table-head.ts <flight url> <dataset> <table>

import { createQuery, datasetReader } from "@pricetag/sdk/internal"

const [url, dataset, table] = process.argv.slice(2) as [string, string, string]
const reader = datasetReader(createQuery(url, undefined), { baseDataset: dataset, dataset })
const head = await reader.processedThrough(1, Number.MAX_SAFE_INTEGER, [table])
if (head !== null) console.log(head)
// The query's connection would keep it running.
process.exit(0)
