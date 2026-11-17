# 会員まわり（会員・住所・レビュー・お気に入り）

table "customers" {
  schema  = schema.public
  comment = "会員"
  column "id" {
    type = bigserial
  }
  column "email" {
    type = character_varying(255)
  }
  column "password_hash" {
    type = text
  }
  column "name" {
    type = character_varying(100)
  }
  column "phone" {
    null = true
    type = character_varying(20)
  }
  column "points" {
    type    = integer
    default = 0
    comment = "保有ポイント"
  }
  column "created_at" {
    type    = timestamptz
    default = sql("now()")
  }
  column "deleted_at" {
    null    = true
    type    = timestamptz
    comment = "退会日時"
  }
  primary_key {
    columns = [column.id]
  }
  unique "customers_email_key" {
    columns = [column.email]
  }
}

table "addresses" {
  schema  = schema.public
  comment = "お届け先"
  column "id" {
    type = bigserial
  }
  column "customer_id" {
    type = bigint
  }
  column "recipient_name" {
    type = character_varying(100)
  }
  column "postal_code" {
    type = character(7)
  }
  column "prefecture" {
    type = character_varying(10)
  }
  column "city" {
    type = character_varying(100)
  }
  column "line1" {
    type = character_varying(255)
  }
  column "line2" {
    null = true
    type = character_varying(255)
  }
  column "is_default" {
    type    = boolean
    default = false
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "addresses_customer_id_fkey" {
    columns     = [column.customer_id]
    ref_columns = [table.customers.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  # 既定のお届け先は会員ごとに 1 つ
  index "addresses_default_key" {
    unique  = true
    columns = [column.customer_id]
    where   = "is_default"
  }
}

table "reviews" {
  schema  = schema.public
  comment = "商品レビュー"
  column "id" {
    type = bigserial
  }
  column "product_id" {
    type = bigint
  }
  column "customer_id" {
    type = bigint
  }
  column "rating" {
    type    = smallint
    comment = "1〜5"
  }
  column "title" {
    null = true
    type = character_varying(100)
  }
  column "body" {
    null = true
    type = text
  }
  column "created_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "reviews_product_id_fkey" {
    columns     = [column.product_id]
    ref_columns = [table.products.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "reviews_customer_id_fkey" {
    columns     = [column.customer_id]
    ref_columns = [table.customers.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  unique "reviews_product_customer_key" {
    columns = [column.product_id, column.customer_id]
  }
  check "reviews_rating_check" {
    expr = "((rating >= 1) AND (rating <= 5))"
  }
}

table "wishlist_items" {
  schema  = schema.public
  comment = "お気に入り"
  column "customer_id" {
    type = bigint
  }
  column "product_id" {
    type = bigint
  }
  column "created_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.customer_id, column.product_id]
  }
  foreign_key "wishlist_items_customer_id_fkey" {
    columns     = [column.customer_id]
    ref_columns = [table.customers.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  foreign_key "wishlist_items_product_id_fkey" {
    columns     = [column.product_id]
    ref_columns = [table.products.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
}
