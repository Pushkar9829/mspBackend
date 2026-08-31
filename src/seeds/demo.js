import bcrypt from "bcryptjs";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { Brand } from "../modules/catalog/brand.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Media } from "../modules/catalog/media.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { InventoryTransaction } from "../modules/inventory/transaction.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { CouponUsage } from "../modules/pricing/couponUsage.model.js";
import { Offer } from "../modules/pricing/offer.model.js";
import { PriceList } from "../modules/pricing/priceList.model.js";
import { Address } from "../modules/location/address.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Conversation } from "../modules/chat/conversation.model.js";
import { Message } from "../modules/chat/message.model.js";
import { Notification } from "../modules/notifications/notification.model.js";
import { CmsPage } from "../modules/cms/cmsPage.model.js";
import { AnalyticsEvent } from "../modules/analytics/event.model.js";
import { AnalyticsDaily } from "../modules/analytics/daily.model.js";
import { AuditLog } from "../modules/audit/auditLog.model.js";
import { SYSTEM_ROLES } from "../config/constants.js";
import { SALT } from "../modules/auth/service.js";
import { IMPORTANT_EVENTS } from "../modules/analytics/events.catalog.js";

const CATEGORIES = [
  { slug: "staples", name: "Staples", icon: "🌾" },
  { slug: "beverages", name: "Beverages", icon: "🍵" },
  { slug: "snacks", name: "Snacks", icon: "🍪" },
  { slug: "personal-care", name: "Personal Care", icon: "🧴" },
  { slug: "home-care", name: "Home Care", icon: "🫧" },
  { slug: "baby-care", name: "Baby Care", icon: "🍼" },
  { slug: "health", name: "Health & Wellness", icon: "💊" },
  { slug: "dairy", name: "Dairy & Bakery", icon: "🥛" },
];

const NEEDS = [
  { slug: "cooking", name: "Cooking Essentials", icon: "🍳", parent: "staples" },
  { slug: "masala", name: "Masala & Spices", icon: "🌶️", parent: "staples" },
  { slug: "pulses", name: "Pulses & Grains", icon: "🫘", parent: "staples" },
  { slug: "sauces", name: "Sauces & Ketchup", icon: "🍅", parent: "staples" },
  { slug: "biscuits", name: "Biscuits & Cookies", icon: "🍪", parent: "snacks" },
  { slug: "chocolates", name: "Chocolates", icon: "🍫", parent: "snacks" },
  { slug: "cleaning", name: "Cleaning Essentials", icon: "🧹", parent: "home-care" },
  { slug: "tissues", name: "Tissues & Papers", icon: "🧻", parent: "home-care" },
];

const BRANDS = [
  { slug: "tata", name: "Tata" },
  { slug: "fortune", name: "Fortune" },
  { slug: "maggi", name: "Maggi" },
  { slug: "surf-excel", name: "Surf Excel" },
  { slug: "aashirvaad", name: "Aashirvaad" },
  { slug: "parle", name: "Parle" },
  { slug: "amul", name: "Amul" },
  { slug: "dove", name: "Dove" },
  { slug: "hul", name: "HUL" },
  { slug: "colgate", name: "Colgate" },
  { slug: "dettol", name: "Dettol" },
  { slug: "mdh", name: "MDH" },
];

const CATALOG = [
  {
    id: "tata-tea-premium",
    name: "Tata Tea Premium",
    brand: "tata",
    category: "beverages",
    weight: "1 kg",
    packs: ["250g", "500g", "1 kg", "2 kg"],
    price: 245,
    mrp: 280,
    stock: 240,
    image: "https://images.unsplash.com/photo-1597318181409-cf64d0b5b8a0?auto=format&fit=crop&w=640&q=80",
    gallery: [
      "https://images.unsplash.com/photo-1597318181409-cf64d0b5b8a0?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1564890369478-c89ca6d9cde9?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "A rich, fragrant blend of quality tea leaves for everyday chai. Ideal for households, offices and bulk retail orders.",
    features: ["Strong aroma", "Consistent brew", "Pan-India favourite", "Retailer-friendly packs"],
    ingredients: "Tea leaves, natural flavours.",
    nutrition: "Energy 0 kcal per cup without milk/sugar.",
    manufacturer: "Tata Consumer Products Ltd.",
    bestseller: true,
    deal: true,
  },
  {
    id: "fortune-sunflower-oil",
    name: "Fortune Sunflower Oil",
    brand: "fortune",
    category: "staples",
    weight: "5 L",
    packs: ["1 L", "5 L", "15 L"],
    price: 745,
    mrp: 820,
    stock: 120,
    image: "https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=800&q=80"],
    description: "Light, healthy sunflower oil for everyday cooking and bulk kitchen use.",
    features: ["Light taste", "Vitamin A & D", "Sealed pack"],
    ingredients: "Refined sunflower oil.",
    nutrition: "900 kcal per 100 ml.",
    manufacturer: "Adani Wilmar Ltd.",
    bestseller: true,
  },
  {
    id: "aashirvaad-atta",
    name: "Aashirvaad Whole Wheat Atta",
    brand: "aashirvaad",
    category: "staples",
    weight: "10 kg",
    packs: ["5 kg", "10 kg"],
    price: 425,
    mrp: 480,
    stock: 80,
    image: "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=800&q=80"],
    description: "100% whole wheat atta with a lock of freshness for soft rotis.",
    features: ["Chakki fresh", "Soft rotis", "Bulk packs"],
    ingredients: "Whole wheat.",
    nutrition: "Carbs 69g / 100g.",
    manufacturer: "ITC Ltd.",
    bestseller: true,
  },
  {
    id: "maggi-masala",
    name: "Maggi 2-Minute Masala Noodles",
    brand: "maggi",
    category: "snacks",
    weight: "12 pack",
    packs: ["8 pack", "12 pack", "24 pack"],
    price: 138,
    mrp: 168,
    stock: 500,
    image: "https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?auto=format&fit=crop&w=800&q=80"],
    description: "India's favourite instant noodles. Fast-moving SKU for kirana and bulk buyers.",
    features: ["Ready in 2 minutes", "Masala taste", "High velocity SKU"],
    ingredients: "Wheat flour, palm oil, spices.",
    nutrition: "Energy 401 kcal / 100g.",
    manufacturer: "Nestlé India.",
    deal: true,
    bestseller: true,
  },
  {
    id: "surf-excel",
    name: "Surf Excel Easy Wash",
    brand: "surf-excel",
    category: "home-care",
    weight: "4 kg",
    packs: ["1 kg", "2 kg", "4 kg"],
    price: 429,
    mrp: 499,
    stock: 90,
    image: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=800&q=80"],
    description: "Removes tough stains with less effort. Popular home-care staple.",
    features: ["Stain removal", "Value pack", "Retail favourite"],
    ingredients: "Anionic surfactants, enzymes.",
    nutrition: "Not a food product.",
    manufacturer: "Hindustan Unilever Ltd.",
    bestseller: true,
  },
  {
    id: "parle-g",
    name: "Parle-G Glucose Biscuits",
    brand: "parle",
    category: "snacks",
    weight: "800 g",
    packs: ["250 g", "800 g", "1.5 kg"],
    price: 70,
    mrp: 80,
    stock: 800,
    image: "https://images.unsplash.com/photo-1558961363-fa8fdf82db35?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1558961363-fa8fdf82db35?auto=format&fit=crop&w=800&q=80"],
    description: "The world's largest selling biscuit. Perfect for bulk kirana orders.",
    features: ["Everyday snack", "Long shelf life", "High repeat"],
    ingredients: "Wheat flour, sugar, edible vegetable oil.",
    nutrition: "Energy 453 kcal / 100g.",
    manufacturer: "Parle Products Pvt. Ltd.",
    bestseller: true,
  },
  {
    id: "amul-butter",
    name: "Amul Pasteurised Butter",
    brand: "amul",
    category: "dairy",
    weight: "500 g",
    packs: ["100 g", "500 g"],
    price: 275,
    mrp: 285,
    stock: 60,
    image: "https://images.unsplash.com/photo-1589985270826-4dfd61180d4c?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1589985270826-4dfd61180d4c?auto=format&fit=crop&w=800&q=80"],
    description: "Fresh, creamy Amul butter. Keep refrigerated.",
    features: ["Pasteurised", "No added colour", "Trusted dairy"],
    ingredients: "Pasteurised cream, salt.",
    nutrition: "Fat 80g / 100g.",
    manufacturer: "GCMMF (Amul).",
    newLaunch: true,
  },
  {
    id: "dove-shampoo",
    name: "Dove Intense Repair Shampoo",
    brand: "dove",
    category: "personal-care",
    weight: "650 ml",
    packs: ["340 ml", "650 ml"],
    price: 365,
    mrp: 420,
    stock: 150,
    image: "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80"],
    description: "Nourishing shampoo for damaged hair. Fast mover in personal care.",
    features: ["Repair care", "Family pack", "HUL brand"],
    ingredients: "Aqua, surfactants, conditioning agents.",
    nutrition: "Not a food product.",
    manufacturer: "Hindustan Unilever Ltd.",
    newLaunch: true,
  },
  {
    id: "red-label",
    name: "Brooke Bond Red Label",
    brand: "hul",
    category: "beverages",
    weight: "1 kg",
    packs: ["250g", "500g", "1 kg"],
    price: 230,
    mrp: 260,
    stock: 210,
    image: "https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=800&q=80"],
    description: "A strong cup of tea with a rich colour and aroma.",
    features: ["Strong brew", "Family pack"],
    ingredients: "Tea leaves.",
    nutrition: "0 kcal per cup.",
    manufacturer: "Hindustan Unilever Ltd.",
    deal: true,
  },
  {
    id: "colgate-strong",
    name: "Colgate Strong Teeth",
    brand: "colgate",
    category: "personal-care",
    weight: "200 g",
    packs: ["100 g", "200 g", "300 g"],
    price: 98,
    mrp: 120,
    stock: 400,
    image: "https://images.unsplash.com/photo-1559591935-c6c92c6c2c8e?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1559591935-c6c92c6c2c8e?auto=format&fit=crop&w=800&q=80"],
    description: "Calcium-rich toothpaste for everyday oral care.",
    features: ["Calcium boost", "Family SKU"],
    ingredients: "Calcium carbonate, fluoride.",
    nutrition: "Not a food product.",
    manufacturer: "Colgate-Palmolive India.",
    newLaunch: true,
  },
  {
    id: "dettol-soap",
    name: "Dettol Original Soap",
    brand: "dettol",
    category: "personal-care",
    weight: "4 x 125 g",
    packs: ["1 bar", "4 x 125 g"],
    price: 165,
    mrp: 198,
    stock: 260,
    image: "https://images.unsplash.com/photo-1584305574647-0cc949a2bb9f?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1584305574647-0cc949a2bb9f?auto=format&fit=crop&w=800&q=80"],
    description: "Trusted germ-protection soap in a value multipack.",
    features: ["Germ protection", "Value pack"],
    ingredients: "Soap noodles, triclocarban.",
    nutrition: "Not a food product.",
    manufacturer: "Reckitt.",
    deal: true,
  },
  {
    id: "mdh-kitchen-king",
    name: "MDH Kitchen King Masala",
    brand: "mdh",
    category: "staples",
    weight: "500 g",
    packs: ["100 g", "500 g"],
    price: 210,
    mrp: 240,
    stock: 140,
    image: "https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=640&q=80",
    gallery: ["https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=800&q=80"],
    description: "Aromatic blend for gravies, sabzis and bulk kitchen use.",
    features: ["Authentic blend", "Airtight pack"],
    ingredients: "Coriander, chilli, turmeric, spices.",
    nutrition: "Use as seasoning.",
    manufacturer: "Mahashian Di Hatti Pvt. Ltd.",
    newLaunch: true,
  },
];

function slugPack(pack) {
  return String(pack)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function unitFromPack(pack) {
  const p = String(pack).toLowerCase();
  if (p.includes("kg")) return "kg";
  if (p.includes("ml")) return "ml";
  if (p.includes("l")) return "L";
  if (p.includes("g")) return "g";
  return "pc";
}

function numericMass(value) {
  const n = parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = String(value).toLowerCase();
  if (/\bkg\b|\bl\b/.test(s) && !s.includes("ml")) return n * 1000;
  return n;
}

function packPrice(product, pack) {
  if (pack === product.weight) return { selling: product.price, list: product.mrp };
  const packN = numericMass(pack);
  const defN = numericMass(product.weight);
  if (packN && defN) {
    const ratio = packN / defN;
    return { selling: Math.max(1, Math.round(product.price * ratio)), list: Math.max(1, Math.round(product.mrp * ratio)) };
  }
  return { selling: product.price, list: product.mrp };
}

function barcodeFor(sku) {
  let n = 0;
  for (const ch of sku) n = (n * 31 + ch.charCodeAt(0)) % 100000000;
  return `890${String(n).padStart(10, "0")}`;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

async function ensureUser({ email, password, ...fields }) {
  const lowered = email.toLowerCase();
  let user = await User.findOne({ email: lowered });
  if (!user) {
    user = await User.create({
      email: lowered,
      passwordHash: await bcrypt.hash(password, SALT),
      status: "active",
      ...fields,
    });
  } else {
    const { password: _pw, ...rest } = { password, ...fields };
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          ...rest,
          status: "active",
          passwordHash: await bcrypt.hash(password, SALT),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }
    );
    user = await User.findById(user._id);
  }
  return user;
}

export async function seedDemoCatalog() {
  const tenantAdminRole = await Role.findOne({ slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true });
  const buyerRole = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true });
  const supportRole = await Role.findOne({ slug: SYSTEM_ROLES.SUPPORT_AGENT, isSystem: true });
  if (!tenantAdminRole || !buyerRole || !supportRole) {
    throw new Error("System roles missing — run seedFoundation first");
  }

  const tenant = await Tenant.findOneAndUpdate(
    { slug: "acme-wholesale" },
    {
      $set: {
        name: "Acme Wholesale",
        slug: "acme-wholesale",
        status: "active",
        branding: {
          logo: "https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=128&q=80",
          primaryColor: "#322FBC",
          secondaryColor: "#8B8AAE",
        },
        businessProfile: {
          legalName: "Acme Wholesale Private Limited",
          gstin: "07AABCA1234A1Z5",
          email: "vendor@acme.local",
          phone: "01140001234",
          website: "https://acme.local",
        },
        taxSettings: { defaultTaxRate: 18, currency: "INR" },
        orderRules: { minOrderValue: 500, allowBackorder: false },
        deliveryZones: [
          {
            name: "Delhi NCR",
            pincodes: ["110001", "110002", "122001", "201301"],
            etaDaysMin: 1,
            etaDaysMax: 3,
            deliveryFee: 0,
          },
          {
            name: "Mumbai",
            pincodes: ["400001", "400002", "400050"],
            etaDaysMin: 2,
            etaDaysMax: 4,
            deliveryFee: 80,
          },
          {
            name: "Rest of India",
            pincodes: [],
            radiusKm: 2000,
            center: { latitude: 28.61, longitude: 77.2 },
            etaDaysMin: 4,
            etaDaysMax: 8,
            deliveryFee: 150,
          },
        ],
        notificationPreferences: { email: true, inApp: true },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Settings.findOneAndUpdate(
    { scope: "tenant", tenantId: tenant._id, key: "store.displayName" },
    { $set: { value: "Acme Wholesale" } },
    { upsert: true }
  );

  const tenantAdmin = await ensureUser({
    email: "vendor@acme.local",
    password: "Vendor123!",
    name: "Acme Admin",
    phone: "9810011100",
    tenantId: tenant._id,
    roleId: tenantAdminRole._id,
    profile: {
      company: "Acme Wholesale",
      preferredSizes: ["case", "outer"],
      location: { city: "Delhi", state: "DL", postalCode: "110001", country: "IN", latitude: 28.61, longitude: 77.2 },
    },
  });

  const support = await ensureUser({
    email: "support@acme.local",
    password: "Support123!",
    name: "Acme Support",
    phone: "9810022200",
    tenantId: tenant._id,
    roleId: supportRole._id,
    profile: { company: "Acme Wholesale", location: { city: "Delhi", state: "DL", postalCode: "110001", country: "IN" } },
  });

  const buyersSpec = [
    {
      email: "buyer@acme.local",
      password: "Buyer123!",
      name: "Demo Buyer",
      phone: "9999999999",
      company: "Retail Mart",
      city: "Delhi",
      state: "DL",
      postalCode: "110001",
      address: "12 Connaught Place",
    },
    {
      email: "kirana@acme.local",
      password: "Buyer123!",
      name: "Ravi Kirana",
      phone: "9811100001",
      company: "Kirana Plus",
      city: "Delhi",
      state: "DL",
      postalCode: "110002",
      address: "45 Karol Bagh",
    },
    {
      email: "cityfoods@acme.local",
      password: "Buyer123!",
      name: "Meera Shah",
      phone: "9811100002",
      company: "City Foods",
      city: "Mumbai",
      state: "MH",
      postalCode: "400001",
      address: "1 MG Road",
    },
    {
      email: "dailyneeds@acme.local",
      password: "Buyer123!",
      name: "Amit Patel",
      phone: "9811100003",
      company: "Daily Needs",
      city: "Delhi",
      state: "DL",
      postalCode: "110001",
      address: "8 Chandni Chowk",
    },
    {
      email: "metromart@acme.local",
      password: "Buyer123!",
      name: "Sana Khan",
      phone: "9811100004",
      company: "Metro Mart",
      city: "Mumbai",
      state: "MH",
      postalCode: "400001",
      address: "22 Colaba Causeway",
    },
  ];

  const buyers = {};
  for (const spec of buyersSpec) {
    buyers[spec.email] = await ensureUser({
      email: spec.email,
      password: spec.password,
      name: spec.name,
      phone: spec.phone,
      tenantId: tenant._id,
      roleId: buyerRole._id,
      profile: {
        company: spec.company,
        preferredSizes: ["outer", "case"],
        location: { city: spec.city, state: spec.state, postalCode: spec.postalCode, country: "IN" },
      },
    });
  }
  const buyer = buyers["buyer@acme.local"];

  const categoryBySlug = {};
  for (const [i, cat] of CATEGORIES.entries()) {
    categoryBySlug[cat.slug] = await Category.findOneAndUpdate(
      { slug: cat.slug },
      {
        $set: {
          name: cat.name,
          slug: cat.slug,
          parentId: null,
          status: "active",
          sortOrder: i + 1,
          icon: cat.icon,
          image: "",
          seo: { title: `${cat.name} | MS₹`, description: `Wholesale ${cat.name.toLowerCase()} for kirana and bulk buyers.` },
        },
      },
      { upsert: true, new: true }
    );
  }
  for (const [i, need] of NEEDS.entries()) {
    categoryBySlug[need.slug] = await Category.findOneAndUpdate(
      { slug: need.slug },
      {
        $set: {
          name: need.name,
          slug: need.slug,
          parentId: categoryBySlug[need.parent]._id,
          status: "active",
          sortOrder: i + 1,
          icon: need.icon,
          seo: { title: `${need.name} | MS₹`, description: need.name },
        },
      },
      { upsert: true, new: true }
    );
  }

  const brandBySlug = {};
  for (const b of BRANDS) {
    brandBySlug[b.slug] = await Brand.findOneAndUpdate(
      { tenantId: tenant._id, slug: b.slug },
      { $set: { name: b.name, slug: b.slug, tenantId: tenant._id, logo: "", status: "active" } },
      { upsert: true, new: true }
    );
  }

  const productsById = {};
  const variantsBySku = {};
  const defaultVariants = [];

  for (const item of CATALOG) {
    const sku = item.id.toUpperCase();
    const tags = [item.category, item.brand];
    if (item.bestseller) tags.push("bestseller");
    if (item.deal) tags.push("deal");
    if (item.newLaunch) tags.push("new");
    const gstRate = item.category === "dairy" ? 5 : 18;
    const product = await Product.findOneAndUpdate(
      { tenantId: tenant._id, sku },
      {
        $set: {
          tenantId: tenant._id,
          name: item.name,
          sku,
          barcode: barcodeFor(sku),
          description: item.description,
          specifications: {
            features: item.features,
            ingredients: item.ingredients,
            nutrition: item.nutrition,
            manufacturer: item.manufacturer,
            defaultPack: item.weight,
          },
          images: [item.image, ...(item.gallery || [])],
          videos: [],
          documents: [],
          tags,
          categoryId: categoryBySlug[item.category]._id,
          brandId: brandBySlug[item.brand]._id,
          taxClass: { name: gstRate === 5 ? "GST5" : "GST18", rate: gstRate },
          status: "published",
          scheduledAt: null,
          wholesale: { moq: 1, maxQty: 8000, packMultiple: 1, caseQty: 10, leadTimeDays: 2 },
        },
      },
      { upsert: true, new: true }
    );
    productsById[item.id] = product;

    for (const [idx, url] of [item.image, ...(item.gallery || [])].entries()) {
      await Media.findOneAndUpdate(
        { tenantId: tenant._id, key: `products/${sku}/${idx}` },
        {
          $set: {
            tenantId: tenant._id,
            key: `products/${sku}/${idx}`,
            url,
            filename: `${sku}-${idx}.jpg`,
            mimeType: "image/jpeg",
            size: 120000,
            folder: "products",
            tags: [item.category, item.brand],
            uploadedBy: tenantAdmin._id,
          },
        },
        { upsert: true }
      );
    }

    for (const pack of item.packs) {
      const vSku = `${sku}-${slugPack(pack).toUpperCase()}`;
      const { selling, list } = packPrice(item, pack);
      const variant = await ProductVariant.findOneAndUpdate(
        { tenantId: tenant._id, sku: vSku },
        {
          $set: {
            tenantId: tenant._id,
            productId: product._id,
            sku: vSku,
            barcode: barcodeFor(vSku),
            attributes: {
              size: pack,
              color: "",
              grade: item.bestseller ? "A" : "standard",
              material: "",
              packSize: pack,
              unit: unitFromPack(pack),
              weight: numericMass(pack) || 0,
              dimensions: { l: 20, w: 12, h: 8 },
            },
            listPrice: list,
            sellingPrice: selling,
            tierPrices: [
              { minQty: 1, maxQty: 49, unitPrice: selling },
              { minQty: 50, maxQty: 199, unitPrice: Math.round(selling * 0.92) },
              { minQty: 200, maxQty: null, unitPrice: Math.round(selling * 0.85) },
            ],
            status: "active",
          },
        },
        { upsert: true, new: true }
      );
      variantsBySku[vSku] = variant;
      if (pack === item.weight) defaultVariants.push({ item, product, variant, selling, gstRate });
    }
  }

  const delhi = await Warehouse.findOneAndUpdate(
    { tenantId: tenant._id, code: "DEL-01" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Delhi Hub",
        code: "DEL-01",
        addressLine1: "Okhla Industrial Area Phase 2",
        city: "Delhi",
        state: "DL",
        postalCode: "110020",
        country: "IN",
        latitude: 28.53,
        longitude: 77.27,
        status: "active",
      },
    },
    { upsert: true, new: true }
  );
  const mumbai = await Warehouse.findOneAndUpdate(
    { tenantId: tenant._id, code: "MUM-01" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Mumbai Hub",
        code: "MUM-01",
        addressLine1: "Andheri East Warehouse Complex",
        city: "Mumbai",
        state: "MH",
        postalCode: "400069",
        country: "IN",
        latitude: 19.11,
        longitude: 72.87,
        status: "active",
      },
    },
    { upsert: true, new: true }
  );

  const allVariants = Object.values(variantsBySku);
  for (const variant of allVariants) {
    const product = await Product.findById(variant.productId);
    const catalogItem = CATALOG.find((c) => c.id.toUpperCase() === product.sku) || { stock: 100 };
    const base = Math.max(20, catalogItem.stock * 4);
    const rows = [
      { warehouse: delhi, available: Math.round(base * 0.7), threshold: 20 },
      { warehouse: mumbai, available: Math.round(base * 0.3), threshold: 10 },
    ];
    for (const row of rows) {
      const inv = await Inventory.findOneAndUpdate(
        { tenantId: tenant._id, warehouseId: row.warehouse._id, variantId: variant._id },
        {
          $set: {
            sku: variant.sku,
            available: row.available,
            reserved: 0,
            committed: 0,
            damaged: 0,
            incoming: 40,
            lowStockThreshold: row.threshold,
          },
        },
        { upsert: true, new: true }
      );
      const existingTx = await InventoryTransaction.findOne({
        tenantId: tenant._id,
        warehouseId: row.warehouse._id,
        variantId: variant._id,
        reason: "inward",
        reference: "SEED-INWARD",
      });
      if (!existingTx) {
        await InventoryTransaction.create({
          tenantId: tenant._id,
          warehouseId: row.warehouse._id,
          variantId: variant._id,
          sku: variant.sku,
          reason: "inward",
          qty: row.available,
          availableAfter: inv.available,
          reservedAfter: 0,
          committedAfter: 0,
          actorId: tenantAdmin._id,
          reference: "SEED-INWARD",
          note: "Initial demo stock",
        });
      }
    }
  }

  const defaultPriceItems = defaultVariants.map((d) => ({ variantId: d.variant._id, unitPrice: d.selling }));
  await PriceList.findOneAndUpdate(
    { tenantId: tenant._id, name: "Default Wholesale" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Default Wholesale",
        customerId: null,
        isDefault: true,
        status: "active",
        items: defaultPriceItems,
      },
    },
    { upsert: true }
  );
  await PriceList.findOneAndUpdate(
    { tenantId: tenant._id, name: "Retail Mart Contract" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Retail Mart Contract",
        customerId: buyer._id,
        isDefault: false,
        status: "active",
        items: defaultVariants.map((d) => ({ variantId: d.variant._id, unitPrice: Math.round(d.selling * 0.95) })),
      },
    },
    { upsert: true }
  );

  const beverageIds = CATALOG.filter((c) => c.category === "beverages").map((c) => productsById[c.id]._id);
  await Offer.findOneAndUpdate(
    { tenantId: tenant._id, name: "Festival Tea 12%" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Festival Tea 12%",
        type: "percent",
        value: 12,
        productIds: beverageIds,
        categoryIds: [categoryBySlug.beverages._id],
        customerIds: [],
        inventoryCap: 5000,
        inventoryUsed: 120,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 30 * 86400000),
        status: "active",
      },
    },
    { upsert: true }
  );
  await Offer.findOneAndUpdate(
    { tenantId: tenant._id, name: "Flash Maggi" },
    {
      $set: {
        tenantId: tenant._id,
        name: "Flash Maggi",
        type: "flash",
        value: 15,
        productIds: [productsById["maggi-masala"]._id],
        categoryIds: [],
        customerIds: [],
        inventoryCap: 800,
        inventoryUsed: 40,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 2 * 86400000),
        status: "active",
      },
    },
    { upsert: true }
  );

  const welcome = await Coupon.findOneAndUpdate(
    { tenantId: tenant._id, code: "WELCOME10" },
    {
      $set: {
        name: "Welcome 10%",
        type: "percent",
        value: 10,
        minCartValue: 1000,
        maxRedemptions: 10000,
        redemptionCount: 1,
        perCustomerLimit: 100,
        excludedProductIds: [],
        status: "active",
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 365 * 86400000),
      },
    },
    { upsert: true, new: true }
  );
  await Coupon.findOneAndUpdate(
    { tenantId: tenant._id, code: "BULK50" },
    {
      $set: {
        name: "Bulk ₹50 off",
        type: "fixed",
        value: 50,
        minCartValue: 5000,
        maxRedemptions: 500,
        redemptionCount: 0,
        perCustomerLimit: 5,
        excludedProductIds: [],
        status: "active",
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 180 * 86400000),
      },
    },
    { upsert: true }
  );
  await Coupon.findOneAndUpdate(
    { tenantId: tenant._id, code: "SAVE5" },
    {
      $set: {
        name: "Save 5%",
        type: "percent",
        value: 5,
        minCartValue: 0,
        maxRedemptions: 10000,
        redemptionCount: 0,
        perCustomerLimit: 50,
        excludedProductIds: [],
        status: "active",
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 365 * 86400000),
      },
    },
    { upsert: true }
  );

  const addressByEmail = {};
  for (const spec of buyersSpec) {
    const user = buyers[spec.email];
    addressByEmail[spec.email] = await Address.findOneAndUpdate(
      { userId: user._id, label: "Shop" },
      {
        $set: {
          userId: user._id,
          tenantId: tenant._id,
          label: "Shop",
          contactName: spec.name,
          phone: spec.phone,
          addressLine1: spec.address,
          addressLine2: spec.company,
          city: spec.city,
          state: spec.state,
          postalCode: spec.postalCode,
          country: "IN",
          isDefault: true,
          serviceability: { serviceable: true, etaDaysMin: 1, etaDaysMax: 4, deliveryFee: spec.city === "Mumbai" ? 80 : 0 },
        },
      },
      { upsert: true, new: true }
    );
  }

  const cartVariant = defaultVariants[0].variant;
  await Cart.findOneAndUpdate(
    { userId: buyer._id },
    {
      $set: {
        userId: buyer._id,
        guestKey: "",
        couponCode: "WELCOME10",
        items: [
          {
            tenantId: tenant._id,
            productId: defaultVariants[0].product._id,
            variantId: cartVariant._id,
            qty: 20,
          },
        ],
      },
    },
    { upsert: true }
  );

  function line(d, qty, warehouseId) {
    const taxRate = d.gstRate;
    const lineSubtotal = d.selling * qty;
    const tax = Math.round(lineSubtotal * (taxRate / 100));
    return {
      tenantId: tenant._id,
      productId: d.product._id,
      variantId: d.variant._id,
      sku: d.variant.sku,
      name: d.product.name,
      attributes: d.variant.attributes,
      qty,
      listPrice: d.variant.listPrice,
      unitPrice: d.selling,
      lineSubtotal,
      taxRate,
      tax,
      lineTotal: lineSubtotal + tax,
      warehouseId,
    };
  }

  const orderDefs = [
    { number: "MSR10231", email: "buyer@acme.local", status: "delivered", amountHint: 12480, daysAgo: 1, coupon: "WELCOME10" },
    { number: "MSR10218", email: "kirana@acme.local", status: "shipped", amountHint: 3890, daysAgo: 2 },
    { number: "MSR10204", email: "cityfoods@acme.local", status: "confirmed", amountHint: 8720, daysAgo: 2 },
    { number: "MSR10191", email: "dailyneeds@acme.local", status: "pending", amountHint: 2140, daysAgo: 3 },
    { number: "MSR10170", email: "metromart@acme.local", status: "cancelled", amountHint: 6400, daysAgo: 4 },
  ];

  const seededOrders = [];
  for (const [idx, def] of orderDefs.entries()) {
    const user = buyers[def.email];
    const addr = addressByEmail[def.email];
    const pick = defaultVariants.slice(idx, idx + 3);
    const qty = Math.max(10, Math.round(def.amountHint / (pick[0]?.selling || 200)));
    const items = pick.map((d, i) => line(d, Math.max(10, Math.round(qty / (i + 1))), delhi._id));
    const subtotal = items.reduce((s, it) => s + it.lineSubtotal, 0);
    const tax = items.reduce((s, it) => s + it.tax, 0);
    const couponDiscount = def.coupon ? Math.round(subtotal * 0.1) : 0;
    const deliveryFee = addr.city === "Mumbai" ? 80 : 0;
    const total = subtotal + tax + deliveryFee - couponDiscount;
    const createdAt = new Date(Date.now() - def.daysAgo * 86400000);
    const history = [{ status: "pending", at: createdAt, actorId: user._id, note: "Placed via seed" }];
    if (def.status !== "pending") history.push({ status: def.status, at: new Date(createdAt.getTime() + 3600000), actorId: tenantAdmin._id, note: "Status update" });
    const order = await Order.findOneAndUpdate(
      { orderNumber: def.number },
      {
        $set: {
          orderNumber: def.number,
          tenantId: tenant._id,
          buyerId: user._id,
          status: def.status,
          items,
          addressSnapshot: {
            contactName: addr.contactName,
            phone: addr.phone,
            addressLine1: addr.addressLine1,
            city: addr.city,
            state: addr.state,
            postalCode: addr.postalCode,
            country: "IN",
          },
          couponCode: def.coupon || "",
          couponDiscount,
          subtotal,
          tax,
          deliveryFee,
          total,
          paymentMethod: def.status === "cancelled" ? "cod" : "purchase_order",
          paymentStatus: def.status === "delivered" ? "paid" : def.status === "cancelled" ? "failed" : "pending",
          poNumber: `PO-${def.number}`,
          buyerNotes: "Please deliver before noon if possible.",
          sellerNotes: "",
          idempotencyKey: `seed-${def.number}`,
          etaFrom: new Date(createdAt.getTime() + 86400000),
          etaTo: new Date(createdAt.getTime() + 4 * 86400000),
          statusHistory: history,
          fulfillments:
            def.status === "shipped" || def.status === "delivered"
              ? [{ carrier: "Delhivery", trackingNumber: `DLV${def.number}`, shippedAt: createdAt }]
              : [],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (order.createdAt - createdAt > 60000) {
      await Order.updateOne({ _id: order._id }, { $set: { createdAt } });
    }
    seededOrders.push(order);
  }

  const delivered = seededOrders.find((o) => o.orderNumber === "MSR10231");
  if (delivered) {
    await CouponUsage.findOneAndUpdate(
      { tenantId: tenant._id, couponId: welcome._id, userId: buyer._id, orderId: delivered._id },
      { $set: { tenantId: tenant._id, couponId: welcome._id, userId: buyer._id, orderId: delivered._id } },
      { upsert: true }
    );
  }

  const convo = await Conversation.findOneAndUpdate(
    { tenantId: tenant._id, buyerId: buyer._id, subject: "Order MSR10231 delivery window" },
    {
      $set: {
        tenantId: tenant._id,
        buyerId: buyer._id,
        assigneeId: support._id,
        type: "order_support",
        status: "assigned",
        subject: "Order MSR10231 delivery window",
        orderId: delivered?._id || null,
        productId: defaultVariants[0].product._id,
        tags: ["delivery", "seed"],
        escalated: false,
        unreadBuyer: 0,
        unreadAgent: 0,
        lastMessageAt: new Date(),
        cannedReplies: [{ title: "ETA", body: "Your order is packed and will ship today." }],
      },
    },
    { upsert: true, new: true }
  );
  const existingMsg = await Message.findOne({ conversationId: convo._id });
  if (!existingMsg) {
    await Message.create({
      conversationId: convo._id,
      senderId: buyer._id,
      body: "Can you confirm the delivery slot for MSR10231?",
      attachments: [],
      internal: false,
      readBy: [buyer._id, support._id],
    });
    await Message.create({
      conversationId: convo._id,
      senderId: support._id,
      body: "Delivered yesterday to Connaught Place. Let us know if you need a copy of the invoice.",
      attachments: [],
      internal: false,
      readBy: [support._id],
    });
  }

  const notices = [
    { userId: buyer._id, event: "ORDER_DELIVERED", title: "Order delivered", body: "MSR10231 was delivered.", priority: "high" },
    { userId: tenantAdmin._id, event: "LOW_STOCK", title: "Low stock watch", body: "A few SKUs are near threshold in Mumbai Hub.", priority: "normal" },
    { userId: support._id, event: "CHAT_ASSIGNED", title: "New chat assigned", body: "Buyer asked about MSR10231.", priority: "normal" },
  ];
  for (const n of notices) {
    await Notification.findOneAndUpdate(
      { userId: n.userId, event: n.event, title: n.title },
      {
        $set: {
          userId: n.userId,
          tenantId: tenant._id,
          audience: { type: "user", roleSlug: "" },
          event: n.event,
          title: n.title,
          body: n.body,
          data: { orderNumber: "MSR10231" },
          priority: n.priority,
          scheduledAt: null,
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      },
      { upsert: true }
    );
  }

  const cmsPages = [
    {
      slug: "home",
      title: "Acme Wholesale Home",
      type: "home",
      sections: [{ kind: "hero", heading: "Wholesale FMCG for kirana" }, { kind: "bestsellers" }],
    },
    { slug: "faq", title: "FAQ", type: "faq", sections: [{ kind: "faq", q: "What is MOQ?", a: "Most SKUs start at 10 units." }] },
    { slug: "terms", title: "Terms of sale", type: "terms", sections: [{ kind: "html", html: "<p>Standard wholesale terms apply.</p>" }] },
    { slug: "privacy", title: "Privacy policy", type: "privacy", sections: [{ kind: "html", html: "<p>We store order and KYC data securely.</p>" }] },
    { slug: "shipping", title: "Shipping policy", type: "shipping", sections: [{ kind: "html", html: "<p>Delhi NCR 1–3 days. Rest of India 4–8 days.</p>" }] },
  ];
  for (const page of cmsPages) {
    await CmsPage.findOneAndUpdate(
      { tenantId: tenant._id, slug: page.slug },
      {
        $set: {
          tenantId: tenant._id,
          slug: page.slug,
          title: page.title,
          type: page.type,
          status: "published",
          sections: page.sections,
          seo: { title: page.title, description: page.title, canonical: `/${page.slug}` },
          scheduledAt: null,
          publishedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  const eventCount = await AnalyticsEvent.countDocuments({ tenantId: tenant._id, requestId: "seed" });
  if (eventCount === 0) {
    for (let i = 0; i < 7; i++) {
      const occurredAt = new Date(Date.now() - i * 86400000);
      const day = dayKey(occurredAt);
      const events = [
        { event: "ORDER_CREATED", amount: 4000 + i * 500 },
        { event: "ORDER_DELIVERED", amount: 2000 + i * 200 },
        { event: "ACCOUNT_LOGIN", amount: 0 },
        { event: "PRODUCT_PUBLISHED", amount: 0 },
      ];
      for (const ev of events) {
        const meta = IMPORTANT_EVENTS[ev.event];
        await AnalyticsEvent.create({
          event: ev.event,
          category: meta.category,
          importance: meta.importance,
          tenantId: tenant._id,
          userId: buyer._id,
          actorId: tenantAdmin._id,
          resource: meta.category,
          resourceId: delivered?._id || null,
          amount: ev.amount,
          payload: { source: "seed" },
          requestId: "seed",
          day,
          occurredAt,
        });
        await AnalyticsDaily.updateOne(
          { day, tenantId: tenant._id, event: ev.event },
          { $inc: { count: 1, amount: ev.amount }, $setOnInsert: { category: meta.category } },
          { upsert: true }
        );
      }
    }
  }

  const auditCount = await AuditLog.countDocuments({ tenantId: tenant._id, requestId: "seed" });
  if (auditCount === 0) {
    await AuditLog.create([
      {
        actorId: tenantAdmin._id,
        tenantId: tenant._id,
        action: "publish",
        resource: "product",
        resourceId: defaultVariants[0].product._id,
        ip: "127.0.0.1",
        userAgent: "seed",
        requestId: "seed",
        before: { status: "draft" },
        after: { status: "published" },
        metadata: { source: "seed" },
      },
      {
        actorId: tenantAdmin._id,
        tenantId: tenant._id,
        action: "update",
        resource: "order",
        resourceId: delivered?._id || null,
        ip: "127.0.0.1",
        userAgent: "seed",
        requestId: "seed",
        before: { status: "pending" },
        after: { status: "delivered" },
        metadata: { source: "seed" },
      },
    ]);
  }

  return {
    tenantId: tenant._id,
    warehouseId: delhi._id,
    variantId: cartVariant._id,
    productCount: CATALOG.length,
    variantCount: allVariants.length,
    buyerEmail: "buyer@acme.local",
    vendorEmail: "vendor@acme.local",
  };
}
