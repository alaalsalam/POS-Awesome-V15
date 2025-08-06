import {
	db,
	persist,
	checkDbHealth,
	terminatePersistWorker,
	initPersistWorker,
	tableForKey,
} from "./core.js";
import { getAllByCursor } from "./db-utils.js";
import { clearPriceListCache } from "./items.js";
import Dexie from "dexie/dist/dexie.mjs";

// Default TTLs in milliseconds
const OFFERS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const ITEM_DETAILS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Increment this number whenever the cache data structure changes
export const CACHE_VERSION = 1;

// Queue size limit (can be configured via environment variable)
function getEnvVar(key) {
        if (typeof process !== "undefined" && process.env && process.env[key]) {
                return process.env[key];
        }
        if (typeof globalThis !== "undefined" && globalThis[key]) {
                return globalThis[key];
        }
        return undefined;
}

const envQueueLimit = parseInt(getEnvVar("VITE_MAX_QUEUE_ITEMS") || "", 10);
export const MAX_QUEUE_ITEMS =
        Number.isFinite(envQueueLimit) && envQueueLimit > 0 ? envQueueLimit : 500;

// Memory cache object
export const memory = {
	offline_invoices: [],
	offline_customers: [],
	offline_payments: [],
	pos_last_sync_totals: { pending: 0, synced: 0, drafted: 0 },
        uom_cache: {},
        offers_cache: [],
        offers_cache_timestamp: 0,
        customer_balance_cache: {},
        local_stock_cache: {},
        stock_cache_ready: false,
	customer_storage: [],
	pos_opening_storage: null,
	opening_dialog_storage: null,
	sales_persons_storage: [],
	item_details_cache: {},
	tax_template_cache: {},
	translation_cache: {},
	coupons_cache: {},
	item_groups_cache: [],
	items_last_sync: null,
	customers_last_sync: null,
	// Track the current cache schema version
	cache_version: CACHE_VERSION,
	cache_ready: false,
	tax_inclusive: false,
        manual_offline: false,
};

// Initialize memory from IndexedDB and expose a promise for consumers
export let memoryInitPromise;

export function initMemoryCache() {
	if (!memoryInitPromise) {
		memoryInitPromise = (async () => {
			try {
				await checkDbHealth();
				for (const key of Object.keys(memory)) {
					const stored = await db.table(tableForKey(key)).get(key);
					if (stored && stored.value !== undefined) {
						memory[key] = stored.value;
						continue;
					}
					if (typeof localStorage !== "undefined") {
						const ls = localStorage.getItem(`posa_${key}`);
						if (ls) {
							try {
								memory[key] = JSON.parse(ls);
								continue;
							} catch (err) {
								console.error("Failed to parse localStorage for", key, err);
							}
						}
					}
				}

				// Verify cache version and clear outdated caches
				const versionEntry = await db.table(tableForKey("cache_version")).get("cache_version");
				let storedVersion = versionEntry ? versionEntry.value : null;
				if (!storedVersion && typeof localStorage !== "undefined") {
					const v = localStorage.getItem("posa_cache_version");
					if (v) storedVersion = parseInt(v, 10);
				}
				if (storedVersion !== CACHE_VERSION) {
					await forceClearAllCache();
					memory.cache_version = CACHE_VERSION;
					if (typeof localStorage !== "undefined") {
						localStorage.setItem("posa_cache_version", CACHE_VERSION);
					}
					persist("cache_version", CACHE_VERSION);
				} else {
					memory.cache_version = storedVersion || CACHE_VERSION;
				}
				// Mark caches initialized
				memory.cache_ready = true;
                                persist("cache_ready", true);

                                // Start maintenance after cache is ready
                                startCacheMaintenance();
                        } catch (e) {
                                console.error("Failed to initialize memory from DB", e);
                        }
		})();
	}
	return memoryInitPromise;
}

// Reset cached invoices and customers after syncing
export function resetOfflineState() {
	memory.offline_invoices = [];
	memory.offline_customers = [];
	memory.offline_payments = [];
	memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };

	persist("offline_invoices", memory.offline_invoices);
	persist("offline_customers", memory.offline_customers);
	persist("offline_payments", memory.offline_payments);
	persist("pos_last_sync_totals", memory.pos_last_sync_totals);
}

export function reduceCacheUsage() {
        clearPriceListCache();
        memory.item_details_cache = {};
        memory.uom_cache = {};
        memory.offers_cache = [];
        memory.offers_cache_timestamp = 0;
        memory.customer_balance_cache = {};
        memory.local_stock_cache = {};
        memory.stock_cache_ready = false;
	memory.coupons_cache = {};
	memory.item_groups_cache = [];
	persist("item_details_cache", memory.item_details_cache);
	persist("uom_cache", memory.uom_cache);
        persist("offers_cache", memory.offers_cache);
        persist("offers_cache_timestamp", memory.offers_cache_timestamp);
        persist("customer_balance_cache", memory.customer_balance_cache);
        persist("local_stock_cache", memory.local_stock_cache);
        persist("stock_cache_ready", memory.stock_cache_ready);
	persist("coupons_cache", memory.coupons_cache);
	persist("item_groups_cache", memory.item_groups_cache);
}

// --- Generic getters and setters for cached data ----------------------------

export function getCustomerStorage() {
	return memory.customer_storage || [];
}

export function setCustomerStorage(customers, shouldPersist = true) {
	try {
		memory.customer_storage = customers.map((c) => ({
			name: c.name,
			customer_name: c.customer_name,
			mobile_no: c.mobile_no,
			email_id: c.email_id,
			primary_address: c.primary_address,
			tax_id: c.tax_id,
		}));
	} catch (e) {
		console.error("Failed to trim customers for storage", e);
		memory.customer_storage = [];
	}
	if (shouldPersist) {
		persist("customer_storage", memory.customer_storage);
	}
}

export function getItemsLastSync() {
	return memory.items_last_sync || null;
}

export function setItemsLastSync(ts) {
	memory.items_last_sync = ts;
	persist("items_last_sync", memory.items_last_sync);
}

export function getCustomersLastSync() {
	return memory.customers_last_sync || null;
}

export function setCustomersLastSync(ts) {
	memory.customers_last_sync = ts;
	persist("customers_last_sync", memory.customers_last_sync);
}

export function getSalesPersonsStorage() {
	return memory.sales_persons_storage || [];
}

export function setSalesPersonsStorage(data) {
	try {
		let clean;
		try {
			clean = JSON.parse(JSON.stringify(data));
		} catch (err) {
			console.error("Failed to serialize sales persons", err);
			clean = [];
		}
		memory.sales_persons_storage = clean;
		persist("sales_persons_storage", memory.sales_persons_storage);
	} catch (e) {
		console.error("Failed to set sales persons storage", e);
	}
}

export function getOpeningStorage() {
	return memory.pos_opening_storage || null;
}

export function setOpeningStorage(data) {
	try {
		let clean;
		try {
			clean = JSON.parse(JSON.stringify(data));
		} catch (err) {
			console.error("Failed to serialize opening storage", err);
			clean = {};
		}
		memory.pos_opening_storage = clean;
		persist("pos_opening_storage", memory.pos_opening_storage);
	} catch (e) {
		console.error("Failed to set opening storage", e);
	}
}

export function clearOpeningStorage() {
	try {
		memory.pos_opening_storage = null;
		persist("pos_opening_storage", memory.pos_opening_storage);
	} catch (e) {
		console.error("Failed to clear opening storage", e);
	}
}

export function getOpeningDialogStorage() {
	return memory.opening_dialog_storage || null;
}

export function setOpeningDialogStorage(data) {
	try {
		let clean;
		try {
			clean = JSON.parse(JSON.stringify(data));
		} catch (err) {
			console.error("Failed to serialize opening dialog", err);
			clean = {};
		}
		memory.opening_dialog_storage = clean;
		persist("opening_dialog_storage", memory.opening_dialog_storage);
	} catch (e) {
		console.error("Failed to set opening dialog storage", e);
	}
}

export function getTaxTemplate(name) {
	try {
		const cache = memory.tax_template_cache || {};
		return cache[name] || null;
	} catch (e) {
		console.error("Failed to get cached tax template", e);
		return null;
	}
}

export function setTaxTemplate(name, doc) {
	try {
		const cache = memory.tax_template_cache || {};
		let cleanDoc;
		try {
			cleanDoc = JSON.parse(JSON.stringify(doc));
		} catch (err) {
			console.error("Failed to serialize tax template", err);
			cleanDoc = doc ? { ...doc } : {};
		}
		cache[name] = cleanDoc;
		memory.tax_template_cache = cache;
		persist("tax_template_cache", memory.tax_template_cache);
	} catch (e) {
		console.error("Failed to cache tax template", e);
	}
}

export function getTranslationsCache(lang) {
	try {
		const cache = memory.translation_cache || {};
		return cache[lang] || null;
	} catch (e) {
		console.error("Failed to get cached translations", e);
		return null;
	}
}

export function saveTranslationsCache(lang, data) {
	try {
		const cache = memory.translation_cache || {};
		cache[lang] = data;
		memory.translation_cache = cache;
		persist("translation_cache", memory.translation_cache);
	} catch (e) {
		console.error("Failed to cache translations", e);
	}
}

export function setLastSyncTotals(totals) {
	memory.pos_last_sync_totals = totals;
	persist("pos_last_sync_totals", memory.pos_last_sync_totals);
}

export function getLastSyncTotals() {
	return memory.pos_last_sync_totals;
}

export function getTaxInclusiveSetting() {
	return !!memory.tax_inclusive;
}

export function setTaxInclusiveSetting(value) {
	memory.tax_inclusive = !!value;
	persist("tax_inclusive", memory.tax_inclusive);
}

export function isCacheReady() {
	return !!memory.cache_ready;
}

export function isManualOffline() {
	return memory.manual_offline || false;
}

export function setManualOffline(state) {
	memory.manual_offline = !!state;
	persist("manual_offline", memory.manual_offline);
}

export function toggleManualOffline() {
	setManualOffline(!memory.manual_offline);
}

export function queueHealthCheck(limit = MAX_QUEUE_ITEMS) {
	const inv = (memory.offline_invoices || []).length > limit;
	const cus = (memory.offline_customers || []).length > limit;
	const pay = (memory.offline_payments || []).length > limit;
	return inv || cus || pay;
}

export function purgeOldQueueEntries(limit = MAX_QUEUE_ITEMS) {
	if (Array.isArray(memory.offline_invoices) && memory.offline_invoices.length > limit) {
		memory.offline_invoices.splice(0, memory.offline_invoices.length - limit);
		persist("offline_invoices", memory.offline_invoices);
	}
	if (Array.isArray(memory.offline_customers) && memory.offline_customers.length > limit) {
		memory.offline_customers.splice(0, memory.offline_customers.length - limit);
		persist("offline_customers", memory.offline_customers);
	}
	if (Array.isArray(memory.offline_payments) && memory.offline_payments.length > limit) {
		memory.offline_payments.splice(0, memory.offline_payments.length - limit);
		persist("offline_payments", memory.offline_payments);
	}
}

export function evictExpiredCaches(now = Date.now()) {
        try {
                if (memory.offers_cache_timestamp && now - memory.offers_cache_timestamp > OFFERS_CACHE_TTL) {
                        memory.offers_cache = [];
                        memory.offers_cache_timestamp = 0;
                        persist("offers_cache", memory.offers_cache);
                        persist("offers_cache_timestamp", memory.offers_cache_timestamp);
                }

                const cache = memory.item_details_cache || {};
                let changed = false;
                Object.keys(cache).forEach((profile) => {
                        const profileCache = cache[profile] || {};
                        Object.keys(profileCache).forEach((priceList) => {
                                const priceCache = profileCache[priceList] || {};
                                Object.keys(priceCache).forEach((itemCode) => {
                                        const entry = priceCache[itemCode];
                                        if (!entry || now - entry.timestamp > ITEM_DETAILS_CACHE_TTL) {
                                                delete priceCache[itemCode];
                                                changed = true;
                                        }
                                });
                                if (Object.keys(priceCache).length === 0) {
                                        delete profileCache[priceList];
                                        changed = true;
                                }
                        });
                        if (Object.keys(profileCache).length === 0) {
                                delete cache[profile];
                                changed = true;
                        }
                });

                if (changed) {
                        memory.item_details_cache = cache;
                        persist("item_details_cache", memory.item_details_cache);
                }
        } catch (e) {
                console.error("Failed to evict expired caches", e);
        }
}

let maintenanceTimer = null;
export function startCacheMaintenance(interval = 5 * 60 * 1000) {
        if (maintenanceTimer) {
                clearInterval(maintenanceTimer);
        }
        maintenanceTimer = setInterval(() => {
                purgeOldQueueEntries();
                evictExpiredCaches();
        }, interval);
}

export async function clearAllCache() {
	try {
		await checkDbHealth();
		terminatePersistWorker();
		if (db.isOpen()) {
			await db.close();
		}
		await Dexie.delete("posawesome_offline");
		await db.open();
		initPersistWorker();
	} catch (e) {
		console.error("Failed to clear IndexedDB cache", e);
	}

	if (typeof localStorage !== "undefined") {
		Object.keys(localStorage).forEach((key) => {
			if (key.startsWith("posa_")) {
				localStorage.removeItem(key);
			}
		});
	}

	memory.offline_invoices = [];
	memory.offline_customers = [];
	memory.offline_payments = [];
	memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };
        memory.uom_cache = {};
        memory.offers_cache = [];
        memory.offers_cache_timestamp = 0;
        memory.coupons_cache = {};
        memory.customer_balance_cache = {};
        memory.local_stock_cache = {};
	memory.stock_cache_ready = false;
	memory.customer_storage = [];
	memory.items_last_sync = null;
	memory.customers_last_sync = null;
	memory.pos_opening_storage = null;
	memory.opening_dialog_storage = null;
	memory.sales_persons_storage = [];
	memory.item_details_cache = {};
	memory.tax_template_cache = {};
	memory.item_groups_cache = [];
	memory.cache_version = CACHE_VERSION;
	memory.tax_inclusive = false;
	memory.manual_offline = false;

	await clearPriceListCache();

        persist("cache_version", CACHE_VERSION);
}

// Faster cache clearing without reopening the database
export async function forceClearAllCache() {
	terminatePersistWorker();
	if (typeof localStorage !== "undefined") {
		Object.keys(localStorage).forEach((key) => {
			if (key.startsWith("posa_")) {
				localStorage.removeItem(key);
			}
		});
	}

	memory.offline_invoices = [];
	memory.offline_customers = [];
	memory.offline_payments = [];
	memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };
        memory.uom_cache = {};
        memory.offers_cache = [];
        memory.offers_cache_timestamp = 0;
        memory.coupons_cache = {};
        memory.customer_balance_cache = {};
        memory.local_stock_cache = {};
	memory.stock_cache_ready = false;
	memory.customer_storage = [];
	memory.items_last_sync = null;
	memory.customers_last_sync = null;
	memory.pos_opening_storage = null;
	memory.opening_dialog_storage = null;
	memory.sales_persons_storage = [];
	memory.item_details_cache = {};
	memory.tax_template_cache = {};
	memory.item_groups_cache = [];
	memory.cache_version = CACHE_VERSION;
	memory.tax_inclusive = false;
	memory.manual_offline = false;

	if (typeof localStorage !== "undefined") {
		localStorage.setItem("posa_cache_version", CACHE_VERSION);
	}

	await clearPriceListCache();

	// Delete the IndexedDB database in the background
	try {
		await Dexie.delete("posawesome_offline");
		await db.open();
		initPersistWorker();
	} catch (e) {
		console.error("Failed to clear IndexedDB cache", e);
	}

	persist("cache_version", CACHE_VERSION);
}

/**
 * Estimates the current cache usage size in bytes and percentage
 * @returns {Promise<Object>} Object containing total, localStorage, and indexedDB sizes in bytes, and usage percentage
 */
export async function getCacheUsageEstimate() {
	try {
		await checkDbHealth();
		// Calculate localStorage size
		let localStorageSize = 0;
		if (typeof localStorage !== "undefined") {
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (key && key.startsWith("posa_")) {
					const value = localStorage.getItem(key) || "";
					localStorageSize += (key.length + value.length) * 2; // UTF-16 characters are 2 bytes each
				}
			}
		}

		// Estimate IndexedDB size using cursor to avoid loading everything in memory
		let indexedDBSize = 0;
		try {
			if (db.isOpen()) {
				for (const table of db.tables) {
					const entries = await getAllByCursor(table.name);
					indexedDBSize += entries.reduce((size, item) => {
						const itemSize = JSON.stringify(item).length * 2; // UTF-16 characters
						return size + itemSize;
					}, 0);
				}
			}
		} catch (e) {
			console.error("Failed to calculate IndexedDB size", e);
		}

		const totalSize = localStorageSize + indexedDBSize;
		const maxSize = 50 * 1024 * 1024; // Assume 50MB as max size
		const usagePercentage = Math.min(100, Math.round((totalSize / maxSize) * 100));

		return {
			total: totalSize,
			localStorage: localStorageSize,
			indexedDB: indexedDBSize,
			percentage: usagePercentage,
		};
	} catch (e) {
		console.error("Failed to estimate cache usage", e);
		return {
			total: 0,
			localStorage: 0,
			indexedDB: 0,
			percentage: 0,
		};
	}
}
