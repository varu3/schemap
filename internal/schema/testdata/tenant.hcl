# tenant スキーマ側。テナント名は変数なので ${var.tenant} を使う
variable "tenant" {
  type = string
}

schema "tenant" {
  name = var.tenant
}

enum "item_status" {
  schema = schema.tenant
  values = ["ACTIVE", "INACTIVE"]
}

table "products" {
  schema = schema.tenant
  column "id" {
    type = serial
  }
  column "shop_id" {
    type = integer
  }
  column "name" {
    type    = character_varying(255)
    comment = "商品名"
  }
  column "price" {
    null = true
    type = numeric(5,4)
  }
  column "status" {
    type = enum.item_status
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "products_shop_id_fkey" {
    columns     = [column.shop_id]
    ref_columns = [table.shops.column.id]
    on_update   = RESTRICT
    on_delete   = RESTRICT
  }
  index "products_name_trgm" {
    type = GIN
    on {
      column = column.name
      ops    = "public.gin_trgm_ops"
    }
  }
  unique "products_shop_name_key" {
    columns = [column.shop_id, column.name]
  }
  check "products_price_check" {
    expr = "(price >= 0)"
  }
}

table "orders" {
  schema = schema.tenant
  column "id" {
    type = serial
  }
  column "item_id" {
    type = integer
  }
  column "parent_id" {
    null = true
    type = integer
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "orders_item_id_fkey" {
    columns     = [column.item_id]
    ref_columns = [table.products.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  # 自分自身を指す FK
  foreign_key "orders_parent_id_fkey" {
    columns     = [column.parent_id]
    ref_columns = [table.orders.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  index "orders_item_id_idx" {
    columns = [column.item_id]
    where   = "(parent_id IS NULL)"
  }
}

trigger "set_products_updated_at" {
  on = table.products
  before {
    update = true
  }
  for = ROW
  execute {
    function = function.set_current_timestamp_updated_at
  }
}
