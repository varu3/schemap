# 商品まわり（カテゴリ・ブランド・商品・SKU・画像・在庫）

table "categories" {
  schema  = schema.public
  comment = "商品カテゴリ。parent_id で階層にする"
  column "id" {
    type = bigserial
  }
  column "parent_id" {
    null    = true
    type    = bigint
    comment = "親カテゴリ。NULL なら最上位"
  }
  column "name" {
    type = character_varying(100)
  }
  column "slug" {
    type    = character_varying(100)
    comment = "URL に使う名前"
  }
  column "sort_order" {
    type    = integer
    default = 0
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "categories_parent_id_fkey" {
    columns     = [column.parent_id]
    ref_columns = [table.categories.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  unique "categories_slug_key" {
    columns = [column.slug]
  }
}

table "brands" {
  schema  = schema.public
  comment = "ブランド"
  column "id" {
    type = bigserial
  }
  column "name" {
    type = character_varying(100)
  }
  column "country" {
    null    = true
    type    = character(2)
    comment = "ISO 3166-1 の国コード"
  }
  primary_key {
    columns = [column.id]
  }
  unique "brands_name_key" {
    columns = [column.name]
  }
}

table "products" {
  schema  = schema.public
  comment = "商品。色やサイズの違いは product_variants に持つ"
  column "id" {
    type = bigserial
  }
  column "category_id" {
    type = bigint
  }
  column "brand_id" {
    null = true
    type = bigint
  }
  column "name" {
    type    = character_varying(255)
    comment = "商品名"
  }
  column "description" {
    null = true
    type = text
  }
  column "status" {
    type    = enum.product_status
    default = "DRAFT"
  }
  column "published_at" {
    null    = true
    type    = timestamptz
    comment = "公開日時。NULL なら未公開"
  }
  column "created_at" {
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "products_category_id_fkey" {
    columns     = [column.category_id]
    ref_columns = [table.categories.column.id]
    on_update   = NO_ACTION
    on_delete   = RESTRICT
  }
  foreign_key "products_brand_id_fkey" {
    columns     = [column.brand_id]
    ref_columns = [table.brands.column.id]
    on_update   = NO_ACTION
    on_delete   = SET_NULL
  }
  index "products_category_id_idx" {
    columns = [column.category_id]
  }
  index "products_on_sale_idx" {
    columns = [column.published_at]
    where   = "(status = 'ON_SALE'::product_status)"
  }
}

table "product_variants" {
  schema  = schema.public
  comment = "SKU（色・サイズごとの販売単位）"
  column "id" {
    type = bigserial
  }
  column "product_id" {
    type = bigint
  }
  column "sku" {
    type    = character_varying(64)
    comment = "在庫管理用のコード"
  }
  column "color" {
    null = true
    type = character_varying(50)
  }
  column "size" {
    null = true
    type = character_varying(20)
  }
  column "price" {
    type    = numeric(10,0)
    comment = "税込価格（円）"
  }
  column "weight_grams" {
    null = true
    type = integer
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "product_variants_product_id_fkey" {
    columns     = [column.product_id]
    ref_columns = [table.products.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  unique "product_variants_sku_key" {
    columns = [column.sku]
  }
  check "product_variants_price_check" {
    expr = "(price >= 0)"
  }
}

table "product_images" {
  schema  = schema.public
  comment = "商品画像"
  column "id" {
    type = bigserial
  }
  column "product_id" {
    type = bigint
  }
  column "url" {
    type = text
  }
  column "alt" {
    null = true
    type = character_varying(255)
  }
  column "position" {
    type    = integer
    default = 0
    comment = "表示順"
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "product_images_product_id_fkey" {
    columns     = [column.product_id]
    ref_columns = [table.products.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
}

table "inventories" {
  schema  = schema.public
  comment = "SKU ごとの在庫数"
  column "variant_id" {
    type = bigint
  }
  column "quantity" {
    type    = integer
    default = 0
  }
  column "reserved" {
    type    = integer
    default = 0
    comment = "注文済みで出荷前の数"
  }
  column "updated_at" {
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.variant_id]
  }
  foreign_key "inventories_variant_id_fkey" {
    columns     = [column.variant_id]
    ref_columns = [table.product_variants.column.id]
    on_update   = NO_ACTION
    on_delete   = CASCADE
  }
  check "inventories_quantity_check" {
    expr = "((quantity >= 0) AND (reserved >= 0) AND (reserved <= quantity))"
  }
}
