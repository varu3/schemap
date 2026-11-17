# 購入まわり（カート・クーポン・注文・支払い・出荷）

table "carts" {
  schema  = schema.public
  comment = "カート。ログイン前は session_id で持つ"
  column "id" {
    type = bigserial
  }
  column "customer_id" {
    null = true
    type = bigint
  }
  column "session_id" {
    null = true
    type = character_varying(64)
  }
  column "updated_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "carts_customer_id_fkey" {
    columns     = [column.customer_id]
    ref_columns = [table.customers.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  check "carts_owner_check" {
    expr = "((customer_id IS NOT NULL) OR (session_id IS NOT NULL))"
  }
}

table "cart_items" {
  schema  = schema.public
  comment = "カートの中身"
  column "cart_id" {
    type = bigint
  }
  column "variant_id" {
    type = bigint
  }
  column "quantity" {
    type    = integer
    default = 1
  }
  primary_key {
    columns = [column.cart_id, column.variant_id]
  }
  foreign_key "cart_items_cart_id_fkey" {
    columns     = [column.cart_id]
    ref_columns = [table.carts.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "cart_items_variant_id_fkey" {
    columns     = [column.variant_id]
    ref_columns = [table.product_variants.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  check "cart_items_quantity_check" {
    expr = "(quantity > 0)"
  }
}

table "coupons" {
  schema  = schema.public
  comment = "クーポン"
  column "id" {
    type = bigserial
  }
  column "code" {
    type = character_varying(32)
  }
  column "discount_amount" {
    null    = true
    type    = numeric(10,0)
    comment = "値引き額（円）"
  }
  column "discount_percent" {
    null    = true
    type    = smallint
    comment = "値引き率（%）"
  }
  column "starts_at" {
    type = timestamptz
  }
  column "ends_at" {
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  unique "coupons_code_key" {
    columns = [column.code]
  }
  check "coupons_discount_check" {
    expr = "((discount_amount IS NULL) <> (discount_percent IS NULL))"
  }
}

table "orders" {
  schema  = schema.public
  comment = "注文"
  column "id" {
    type = bigserial
  }
  column "order_number" {
    type    = character_varying(20)
    comment = "お客様に見せる注文番号"
  }
  column "customer_id" {
    type = bigint
  }
  column "shipping_address_id" {
    type = bigint
  }
  column "coupon_id" {
    null = true
    type = bigint
  }
  column "status" {
    type    = enum.order_status
    default = "PENDING"
  }
  column "subtotal" {
    type = numeric(10,0)
  }
  column "shipping_fee" {
    type    = numeric(10,0)
    default = 0
  }
  column "discount" {
    type    = numeric(10,0)
    default = 0
  }
  column "total" {
    type    = numeric(10,0)
    comment = "subtotal + shipping_fee - discount"
  }
  column "ordered_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "orders_customer_id_fkey" {
    columns     = [column.customer_id]
    ref_columns = [table.customers.column.id]
    on_update   = NO_ACTION
    on_delete   = RESTRICT
  }
  foreign_key "orders_shipping_address_id_fkey" {
    columns     = [column.shipping_address_id]
    ref_columns = [table.addresses.column.id]
    on_update   = NO_ACTION
    on_delete   = RESTRICT
  }
  foreign_key "orders_coupon_id_fkey" {
    columns     = [column.coupon_id]
    ref_columns = [table.coupons.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  unique "orders_order_number_key" {
    columns = [column.order_number]
  }
  index "orders_customer_id_ordered_at_idx" {
    columns = [column.customer_id, column.ordered_at]
  }
  check "orders_total_check" {
    expr = "(total = ((subtotal + shipping_fee) - discount))"
  }
}

table "order_items" {
  schema  = schema.public
  comment = "注文明細。価格は注文時点のものを写して持つ"
  column "id" {
    type = bigserial
  }
  column "order_id" {
    type = bigint
  }
  column "variant_id" {
    type = bigint
  }
  column "product_name" {
    type    = character_varying(255)
    comment = "注文時点の商品名"
  }
  column "unit_price" {
    type = numeric(10,0)
  }
  column "quantity" {
    type = integer
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "order_items_order_id_fkey" {
    columns     = [column.order_id]
    ref_columns = [table.orders.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "order_items_variant_id_fkey" {
    columns     = [column.variant_id]
    ref_columns = [table.product_variants.column.id]
    on_update   = NO_ACTION
    on_delete   = RESTRICT
  }
  check "order_items_quantity_check" {
    expr = "(quantity > 0)"
  }
}

table "payments" {
  schema  = schema.public
  comment = "支払い"
  column "id" {
    type = bigserial
  }
  column "order_id" {
    type = bigint
  }
  column "method" {
    type = enum.payment_method
  }
  column "status" {
    type = enum.payment_status
  }
  column "amount" {
    type = numeric(10,0)
  }
  column "transaction_id" {
    null    = true
    type    = character_varying(100)
    comment = "決済代行会社の取引 ID"
  }
  column "paid_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "payments_order_id_fkey" {
    columns     = [column.order_id]
    ref_columns = [table.orders.column.id]
    on_update   = NO_ACTION
    on_delete   = RESTRICT
  }
}

table "shipments" {
  schema  = schema.public
  comment = "出荷。1 つの注文を分けて送ることがある"
  column "id" {
    type = bigserial
  }
  column "order_id" {
    type = bigint
  }
  column "carrier" {
    type    = character_varying(50)
    comment = "配送業者"
  }
  column "tracking_number" {
    null    = true
    type    = character_varying(50)
    comment = "お問い合わせ番号"
  }
  column "shipped_at" {
    null = true
    type = timestamptz
  }
  column "delivered_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "shipments_order_id_fkey" {
    columns     = [column.order_id]
    ref_columns = [table.orders.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
}
