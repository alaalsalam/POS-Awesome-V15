/* global frappe, __ */
import { nextTick } from "vue";
import _ from "lodash";
import { usePosProfileStore } from "../stores/posProfile.js";

export function useItemAddition() {
        // Remove item from invoice
        const removeItem = (item, context) => {
                const index = context.items.findIndex((el) => el.posa_row_id == item.posa_row_id);
		if (index >= 0) {
			context.items.splice(index, 1);
		}
		// Remove from expanded if present
		context.expanded = context.expanded.filter((id) => id !== item.posa_row_id);
	};

	// Add item to invoice
        const addItem = async (item, context) => {
                const posProfileStore = usePosProfileStore();

                if (!item.uom) {
                        item.uom = item.stock_uom;
                }
		let index = -1;
		if (!context.new_line) {
			// For auto_set_batch enabled, we should check if the item code and UOM match only
			if (context.pos_profile.posa_auto_set_batch && item.has_batch_no) {
				index = context.items.findIndex(
					(el) =>
						el.item_code === item.item_code &&
						el.uom === item.uom &&
						!el.posa_is_offer &&
						!el.posa_is_replace,
				);
			} else {
				index = context.items.findIndex(
					(el) =>
						el.item_code === item.item_code &&
						el.uom === item.uom &&
						!el.posa_is_offer &&
						!el.posa_is_replace &&
						((el.batch_no && item.batch_no && el.batch_no === item.batch_no) ||
							(!el.batch_no && !item.batch_no)),
				);
			}
		}

		let new_item;
		if (index === -1 || context.new_line) {
			new_item = getNewItem(item, context);
			// Handle serial number logic
			if (item.has_serial_no && item.to_set_serial_no) {
				new_item.serial_no_selected = [];
				new_item.serial_no_selected.push(item.to_set_serial_no);
				item.to_set_serial_no = null;
			}
			// Handle batch number logic
			if (item.has_batch_no && item.to_set_batch_no) {
				new_item.batch_no = item.to_set_batch_no;
				item.to_set_batch_no = null;
				item.batch_no = null;
				if (context.setBatchQty) context.setBatchQty(new_item, new_item.batch_no, false);
			}
			// Make quantity negative for returns
			if (context.isReturnInvoice) {
				new_item.qty = -Math.abs(new_item.qty || 1);
			}
			// Apply UOM conversion immediately if barcode specifies a different UOM
			if (context.calc_uom && new_item.uom) {
				await context.calc_uom(new_item, new_item.uom);
			}

			// Attempt to fetch an explicit rate for this UOM from the active price list
			try {
                                const r = await frappe.call({
                                        method: "posawesome.posawesome.api.items.get_price_for_uom",
                                        args: {
                                                item_code: new_item.item_code,
                                                price_list:
                                                        (context.get_price_list && context.get_price_list()) ||
                                                        posProfileStore.posProfile?.selling_price_list,
                                                uom: new_item.uom,
                                        },
                                });
				if (r.message) {
					const price = parseFloat(r.message);
					const baseCurrency = context.price_list_currency || context.pos_profile.currency;

					// Convert price to selected currency when multi-currency is enabled
					let converted_price = price;
					if (
						context.pos_profile.posa_allow_multi_currency &&
						context.selected_currency &&
						context.selected_currency !== baseCurrency
					) {
						converted_price = price * (context.exchange_rate || 1);
					}

					Object.assign(new_item, {
						rate: converted_price,
						price_list_rate: converted_price,
						base_rate: price,
						base_price_list_rate: price,
						_manual_rate_set: true,
						skip_force_update: true,
					});
				}
			} catch (e) {
				console.warn("UOM price fetch failed", e);
			}

			// Check again in case the item was added while awaiting price fetch
			if (!context.new_line) {
				if (context.pos_profile.posa_auto_set_batch && item.has_batch_no) {
					index = context.items.findIndex(
						(el) =>
							el.item_code === item.item_code &&
							el.uom === item.uom &&
							!el.posa_is_offer &&
							!el.posa_is_replace,
					);
				} else {
					index = context.items.findIndex(
						(el) =>
							el.item_code === item.item_code &&
							el.uom === item.uom &&
							!el.posa_is_offer &&
							!el.posa_is_replace &&
							((el.batch_no && item.batch_no && el.batch_no === item.batch_no) ||
								(!el.batch_no && !item.batch_no)),
					);
				}
			}

			if (index === -1 || context.new_line) {
				context.items.unshift(new_item);
				// Skip recalculation to preserve the manually set rate
				if (context.update_item_detail) context.update_item_detail(new_item, false);

				// Expand new item if it has batch or serial number
				if (
					(!context.pos_profile.posa_auto_set_batch && new_item.has_batch_no) ||
					new_item.has_serial_no
				) {
					nextTick(() => {
						context.expanded = [new_item.posa_row_id];
					});
				}
			} else {
				const cur_item = context.items[index];
				if (context.update_items_details) context.update_items_details([cur_item]);
				// Merge serial numbers if any
				if (new_item.serial_no_selected && new_item.serial_no_selected.length) {
					new_item.serial_no_selected.forEach((sn) => {
						if (!cur_item.serial_no_selected.includes(sn)) {
							cur_item.serial_no_selected.push(sn);
						}
					});
				}
				if (context.isReturnInvoice) {
					cur_item.qty -= new_item.qty || 1;
				} else {
					cur_item.qty += new_item.qty || 1;
				}
				if (context.calc_stock_qty) context.calc_stock_qty(cur_item, cur_item.qty);

				if (cur_item.has_batch_no && cur_item.batch_no && context.setBatchQty) {
					context.setBatchQty(cur_item, cur_item.batch_no, false);
				}

				if (context.setSerialNo) context.setSerialNo(cur_item);

				if (context.calc_uom && cur_item.uom) {
					await context.calc_uom(cur_item, cur_item.uom);
				}
			}
		} else {
			const cur_item = context.items[index];
			if (context.update_items_details) context.update_items_details([cur_item]);
			// Serial number logic for existing item
			if (item.has_serial_no && item.to_set_serial_no) {
				if (cur_item.serial_no_selected.includes(item.to_set_serial_no)) {
					context.eventBus.emit("show_message", {
						title: __(`This Serial Number {0} has already been added!`, [item.to_set_serial_no]),
						color: "warning",
					});
					item.to_set_serial_no = null;
					return;
				}
				cur_item.serial_no_selected.push(item.to_set_serial_no);
				item.to_set_serial_no = null;
			}

			// For returns, subtract from quantity to make it more negative
			if (context.isReturnInvoice) {
				cur_item.qty -= item.qty || 1;
			} else {
				cur_item.qty += item.qty || 1;
			}
			if (context.calc_stock_qty) context.calc_stock_qty(cur_item, cur_item.qty);

			// Update batch quantity if needed
			if (cur_item.has_batch_no && cur_item.batch_no && context.setBatchQty) {
				context.setBatchQty(cur_item, cur_item.batch_no, false);
			}

			if (context.setSerialNo) context.setSerialNo(cur_item);

			// Recalculate rates if UOM differs from stock UOM
			if (context.calc_uom && cur_item.uom) {
				await context.calc_uom(cur_item, cur_item.uom);
			}
		}
		if (context.forceUpdate) context.forceUpdate();

		// Only try to expand if new_item exists and should be expanded
		if (
			new_item &&
			((!context.pos_profile.posa_auto_set_batch && new_item.has_batch_no) || new_item.has_serial_no)
		) {
			context.expanded = [new_item.posa_row_id];
		}
	};

	// Create a new item object with default and calculated fields
	const getNewItem = (item, context) => {
		const new_item = { ...item };
		if (!new_item.warehouse) {
			new_item.warehouse = context.pos_profile.warehouse;
		}
		if (!item.qty) {
			item.qty = 1;
		}
		if (!item.posa_is_offer) {
			item.posa_is_offer = 0;
		}
		if (!item.posa_is_replace) {
			item.posa_is_replace = "";
		}

		// Initialize flag for tracking manual rate changes
		new_item._manual_rate_set = false;

		// Set negative quantity for return invoices
		if (context.isReturnInvoice && item.qty > 0) {
			item.qty = -Math.abs(item.qty);
		}

		new_item.stock_qty = item.qty;
		new_item.discount_amount = 0;
		new_item.discount_percentage = 0;
		new_item.discount_amount_per_item = 0;
		new_item.price_list_rate = item.rate;

		// Setup base rates properly for multi-currency
		const baseCurrency = context.price_list_currency || context.pos_profile.currency;
		if (context.selected_currency !== baseCurrency) {
			// Store original base currency values
			new_item.base_price_list_rate = item.rate / context.exchange_rate;
			new_item.base_rate = item.rate / context.exchange_rate;
			new_item.base_discount_amount = 0;
		} else {
			// In base currency, base rates = displayed rates
			new_item.base_price_list_rate = item.rate;
			new_item.base_rate = item.rate;
			new_item.base_discount_amount = 0;
		}

		new_item.qty = item.qty;
		new_item.uom = item.uom ? item.uom : item.stock_uom;
		// Ensure item_uoms is initialized
		new_item.item_uoms = item.item_uoms || [];
		if (new_item.item_uoms.length === 0 && new_item.stock_uom) {
			new_item.item_uoms.push({ uom: new_item.stock_uom, conversion_factor: 1 });
		}
		new_item.actual_batch_qty = "";
		new_item.batch_no_expiry_date = item.batch_no_expiry_date || null;
		new_item.conversion_factor = 1;
		new_item.posa_offers = JSON.stringify([]);
		new_item.posa_offer_applied = 0;
		new_item.posa_is_offer = item.posa_is_offer;
		new_item.posa_is_replace = item.posa_is_replace || null;
		new_item.is_free_item = 0;
		new_item.posa_notes = "";
		new_item.posa_delivery_date = "";
		new_item.posa_row_id = context.makeid ? context.makeid(20) : Math.random().toString(36).substr(2, 20);
		if (new_item.has_serial_no && !new_item.serial_no_selected) {
			new_item.serial_no_selected = [];
			new_item.serial_no_selected_count = 0;
		}
		// Expand row if batch/serial required
		if ((!context.pos_profile.posa_auto_set_batch && new_item.has_batch_no) || new_item.has_serial_no) {
			// Only store the row ID to keep expanded array consistent
			context.expanded.push(new_item.posa_row_id);
		}
		return new_item;
	};

	// Reset all invoice fields to default/empty values
	const clearInvoice = (context) => {
		context.items = [];
		context.posa_offers = [];
		context.expanded = [];
		context.eventBus.emit("set_pos_coupons", []);
		context.posa_coupons = [];
		context.invoice_doc = "";
		context.return_doc = "";
		context.discount_amount = 0;
		context.additional_discount = 0;
		context.additional_discount_percentage = 0;
		context.delivery_charges_rate = 0;
		context.selected_delivery_charge = "";
		// Reset posting date to today
		context.posting_date = frappe.datetime.nowdate();

		// Reset price list to default
		if (context.update_price_list) context.update_price_list();

		// Always reset to default customer after invoice
		context.customer = context.pos_profile.customer;

		context.eventBus.emit("set_customer_readonly", false);
		context.invoiceType = context.pos_profile.posa_default_sales_order ? "Order" : "Invoice";
		context.invoiceTypes = ["Invoice", "Order"];
	};

	// Add this utility for grouping logic, matching ItemsTable.vue
	function groupAndAddItem(items, newItem) {
		// Find a matching item (by item_code, uom, and rate)
		const match = items.find(
			(item) =>
				item.item_code === newItem.item_code &&
				item.uom === newItem.uom &&
				item.rate === newItem.rate,
		);
		if (match) {
			// If found, increment quantity
			match.qty += newItem.qty || 1;
			match.amount = match.qty * match.rate;
		} else {
			items.push({ ...newItem });
		}
	}

	// Debounced version for rapid additions
	const groupAndAddItemDebounced = _.debounce(groupAndAddItem, 50);

	return {
		removeItem,
		addItem,
		getNewItem,
		clearInvoice,
		groupAndAddItem,
		groupAndAddItemDebounced,
	};
}
