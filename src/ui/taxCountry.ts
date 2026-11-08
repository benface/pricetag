import type { CurrencyCode } from "@pricetag/sdk/core"
import { TAX_COUNTRIES, TAX_COUNTRY_CODES, isTaxCountryCode, type TaxCountryCode } from "../core/tax.ts"

export const COUNTRY_KEY = "pricetag.taxCountry"

/** Remembered in this browser. Until it's chosen, the main currency is the best guess. */
export function readCountry(currency: CurrencyCode): TaxCountryCode {
  const value = localStorage.getItem(COUNTRY_KEY)
  if (isTaxCountryCode(value)) return value
  return TAX_COUNTRY_CODES.find((code) => TAX_COUNTRIES[code].currency === currency) ?? "US"
}
