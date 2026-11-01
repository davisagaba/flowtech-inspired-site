// Shared product catalog data for the washroom automation concept site.

const CATALOG = [
  // Hand Dryers
  { id: 1, name: "Jet Hand Dryer", category: "Hand Dryers", price: 95, color: "Stainless Steel", size: "", power: "Mains Operated", code: "FLW-101-001", stock: true,
    images: ["20059730", "8089093", "12124656"] },
  { id: 2, name: "Slimline Hand Dryer", category: "Hand Dryers", price: 79, color: "White", size: "", power: "Mains Operated", code: "FLW-101-002", stock: true,
    images: ["8089093", "12124656", "20059730"] },
  { id: 3, name: "High Speed Hand Dryer", category: "Hand Dryers", price: 139, color: "Stainless Steel", size: "", power: "Mains Operated", code: "FLW-101-003", stock: true,
    images: ["12124656", "20059730", "8089093"] },
  { id: 4, name: "Compact Hand Dryer", category: "Hand Dryers", price: 65, color: "White", size: "", power: "Mains Operated", code: "FLW-101-004", stock: true,
    images: ["20059730", "12124656", "8089093"] },
  { id: 5, name: "Vandal-Resistant Hand Dryer", category: "Hand Dryers", price: 159, color: "Brushed Steel", size: "", power: "Mains Operated", code: "FLW-101-005", stock: true,
    images: ["8089093", "20059730", "12124656"] },
  { id: 6, name: "Low Noise Hand Dryer", category: "Hand Dryers", price: 109, color: "White", size: "", power: "Mains Operated", code: "FLW-101-006", stock: false,
    images: ["12124656", "8089093", "20059730"] },
  { id: 7, name: "Hands-Under Dryer", category: "Hand Dryers", price: 119, color: "Stainless Steel", size: "", power: "Mains Operated", code: "FLW-101-007", stock: true,
    images: ["20059730", "8089093", "12124656"] },
  { id: 8, name: "Wall Recessed Dryer", category: "Hand Dryers", price: 149, color: "Brushed Steel", size: "", power: "Mains Operated", code: "FLW-101-008", stock: true,
    images: ["8089093", "12124656", "20059730"] },

  // Automatic Taps
  { id: 9, name: "Sensor Basin Tap", category: "Automatic Taps", price: 59, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-102-001", stock: true,
    images: ["12124656", "709749", "10099184"] },
  { id: 10, name: "Infrared Mixer Tap", category: "Automatic Taps", price: 79, color: "Chrome", size: "", power: "Mains Operated", code: "FLW-102-002", stock: true,
    images: ["709749", "10099184", "127726"] },
  { id: 11, name: "Battery Sensor Tap", category: "Automatic Taps", price: 49, color: "Matt Black", size: "", power: "Battery Operated", code: "FLW-102-003", stock: true,
    images: ["10099184", "127726", "3616761"] },
  { id: 12, name: "Mains Sensor Tap", category: "Automatic Taps", price: 89, color: "Chrome", size: "", power: "Mains Operated", code: "FLW-102-004", stock: true,
    images: ["127726", "3616761", "6782580"] },
  { id: 13, name: "Deck-Mounted Sensor Tap", category: "Automatic Taps", price: 69, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-102-005", stock: true,
    images: ["3616761", "6782580", "6782573"] },
  { id: 14, name: "Wall-Mounted Sensor Tap", category: "Automatic Taps", price: 75, color: "Matt Black", size: "", power: "Battery Operated", code: "FLW-102-006", stock: false,
    images: ["6782580", "6782573", "6782428"] },
  { id: 15, name: "Dual Sensor Tap", category: "Automatic Taps", price: 99, color: "Chrome", size: "", power: "Both", code: "FLW-102-007", stock: true,
    images: ["6782573", "6782428", "861414"] },
  { id: 16, name: "Temperature Control Sensor Tap", category: "Automatic Taps", price: 129, color: "Chrome", size: "", power: "Mains Operated", code: "FLW-102-008", stock: true,
    images: ["6782428", "861414", "19140578"] },

  // Soap Dispensers
  { id: 17, name: "Automatic Foam Dispenser", category: "Soap Dispensers", price: 39, color: "White", size: "700ml", power: "Battery Operated", code: "FLW-103-001", stock: true,
    images: ["433624", "10568476", "7263030"] },
  { id: 18, name: "Automatic Liquid Soap Dispenser", category: "Soap Dispensers", price: 35, color: "White", size: "800ml", power: "Battery Operated", code: "FLW-103-002", stock: true,
    images: ["10568476", "7263030", "4238996"] },
  { id: 19, name: "Sanitizer Dispenser", category: "Soap Dispensers", price: 45, color: "Stainless Steel", size: "1000ml", power: "Battery Operated", code: "FLW-103-003", stock: true,
    images: ["7263030", "4238996", "4210310"] },
  { id: 20, name: "Wall-Mounted Dispenser 1L", category: "Soap Dispensers", price: 32, color: "White", size: "1000ml", power: "Manual", code: "FLW-103-004", stock: true,
    images: ["4238996", "4210310", "7262767"] },
  { id: 21, name: "Countertop Dispenser", category: "Soap Dispensers", price: 22, color: "Chrome", size: "350ml", power: "Manual", code: "FLW-103-005", stock: true,
    images: ["4210310", "7262767", "12679"] },
  { id: 22, name: "Refillable Soap Dispenser", category: "Soap Dispensers", price: 28, color: "White", size: "500ml", power: "Manual", code: "FLW-103-006", stock: true,
    images: ["7262767", "12679", "433624"] },
  { id: 23, name: "Dual Chamber Dispenser", category: "Soap Dispensers", price: 52, color: "Stainless Steel", size: "600ml x 2", power: "Battery Operated", code: "FLW-103-007", stock: false,
    images: ["12679", "433624", "10568476"] },
  { id: 24, name: "Touchless Gel Dispenser", category: "Soap Dispensers", price: 41, color: "Chrome", size: "750ml", power: "Battery Operated", code: "FLW-103-008", stock: true,
    images: ["433624", "7263030", "4238996"] },

  // Sensor Flushers
  { id: 25, name: "Urinal Sensor Flush Valve", category: "Sensor Flushers", price: 69, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-104-001", stock: true,
    images: ["1909656", "4194864", "4194865"] },
  { id: 26, name: "Concealed Urinal Sensor", category: "Sensor Flushers", price: 109, color: "Chrome", size: "", power: "Mains Operated", code: "FLW-104-002", stock: true,
    images: ["4194864", "4194865", "4194866"] },
  { id: 27, name: "Toilet Sensor Flush Valve", category: "Sensor Flushers", price: 89, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-104-003", stock: true,
    images: ["4194865", "4194866", "1909656"] },
  { id: 28, name: "Battery Urinal Sensor", category: "Sensor Flushers", price: 59, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-104-004", stock: true,
    images: ["4194866", "1909656", "4194864"] },
  { id: 29, name: "Mains Urinal Sensor", category: "Sensor Flushers", price: 99, color: "Chrome", size: "", power: "Mains Operated", code: "FLW-104-005", stock: true,
    images: ["6045174", "29631655", "6444979"] },
  { id: 30, name: "Dual Flush Sensor Valve", category: "Sensor Flushers", price: 119, color: "Matt Black", size: "", power: "Both", code: "FLW-104-006", stock: false,
    images: ["29631655", "6444979", "6045174"] },
  { id: 31, name: "Retrofit Sensor Flush Kit", category: "Sensor Flushers", price: 45, color: "Chrome", size: "", power: "Battery Operated", code: "FLW-104-007", stock: true,
    images: ["6444979", "6045174", "29631655"] },
  { id: 32, name: "Waterless Urinal System", category: "Sensor Flushers", price: 149, color: "White", size: "", power: "Manual", code: "FLW-104-008", stock: true,
    images: ["1909656", "6045174", "4194864"] },

  // Entrance Automation
  { id: 33, name: "Automatic Swing Door Operator", category: "Entrance Automation", price: 389, color: "Silver", size: "", power: "Mains Operated", code: "FLW-105-001", stock: true,
    images: ["18939181", "1098982", "20059730"] },
  { id: 34, name: "Automatic Sliding Door", category: "Entrance Automation", price: 459, color: "Silver", size: "", power: "Mains Operated", code: "FLW-105-002", stock: true,
    images: ["1098982", "18939181", "8089093"] },
  { id: 35, name: "Revolving Door System", category: "Entrance Automation", price: 1299, color: "Silver", size: "", power: "Mains Operated", code: "FLW-105-003", stock: true,
    images: ["18939181", "1098982", "20059730"] },
  { id: 36, name: "Low Energy Door Operator", category: "Entrance Automation", price: 259, color: "Black", size: "", power: "Mains Operated", code: "FLW-105-004", stock: true,
    images: ["1098982", "20059730", "18939181"] },
  { id: 37, name: "Access Control Sensor Door", category: "Entrance Automation", price: 329, color: "Silver", size: "", power: "Mains Operated", code: "FLW-105-005", stock: false,
    images: ["18939181", "8089093", "1098982"] },
  { id: 38, name: "Glass Door Automation Kit", category: "Entrance Automation", price: 219, color: "Black", size: "", power: "Mains Operated", code: "FLW-105-006", stock: true,
    images: ["1098982", "18939181", "20059730"] },
  { id: 39, name: "Entrance Sensor Mat", category: "Entrance Automation", price: 89, color: "Black", size: "", power: "Battery Operated", code: "FLW-105-007", stock: true,
    images: ["18939181", "20059730", "8089093"] },
  { id: 40, name: "Automatic Door Closer", category: "Entrance Automation", price: 69, color: "Silver", size: "", power: "Manual", code: "FLW-105-008", stock: true,
    images: ["1098982", "8089093", "18939181"] },

  // Accessories
  { id: 41, name: "Washroom Panel Partition", category: "Accessories", price: 149, color: "White", size: "", power: "", code: "FLW-106-001", stock: true,
    images: ["7262767", "4238996", "4210310"] },
  { id: 42, name: "Grab Bar", category: "Accessories", price: 29, color: "Stainless Steel", size: "60cm", power: "", code: "FLW-106-002", stock: true,
    images: ["4238996", "4210310", "12679"] },
  { id: 43, name: "Mirror with Sensor Light", category: "Accessories", price: 79, color: "Silver", size: "", power: "Battery Operated", code: "FLW-106-003", stock: true,
    images: ["4210310", "12679", "7262767"] },
  { id: 44, name: "Hand Towel Dispenser", category: "Accessories", price: 35, color: "Stainless Steel", size: "", power: "Manual", code: "FLW-106-004", stock: true,
    images: ["12679", "7262767", "4238996"] },
  { id: 45, name: "Floor Drain Cover", category: "Accessories", price: 14, color: "Stainless Steel", size: "15cm", power: "", code: "FLW-106-005", stock: true,
    images: ["6782573", "127726", "4238996"] },
  { id: 46, name: "Stainless Steel Shelf", category: "Accessories", price: 19, color: "Stainless Steel", size: "30cm", power: "", code: "FLW-106-006", stock: false,
    images: ["127726", "6782573", "4210310"] },
  { id: 47, name: "Waste Bin Sensor Lid", category: "Accessories", price: 42, color: "Stainless Steel", size: "30L", power: "Battery Operated", code: "FLW-106-007", stock: true,
    images: ["7262767", "12679", "4210310"] },
  { id: 48, name: "Cubicle Lock System", category: "Accessories", price: 24, color: "Chrome", size: "", power: "", code: "FLW-106-008", stock: true,
    images: ["4238996", "4210310", "12679"] },

  // Added from reference product research
  { id: 49, name: "Plural Urinal", category: "Sensor Flushers", price: 179, color: "Matt Black", size: "Back Inlet", power: "Mains Operated", code: "FLW-104-009", stock: true,
    desc: "Rim-ex touch-free urinal with a back inlet and vibration sensor flush, finished in matt black for a discreet, contemporary washroom.",
    images: ["6045174", "1909656", "29631655"] },
];

const GBP_TO_ZAR_RATE = 24;
const zarFormatter = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });

function formatPrice(basePrice) {
  return zarFormatter.format(basePrice * GBP_TO_ZAR_RATE);
}

function formatPriceWithStrike(basePrice) {
  const original = basePrice * 1.18;
  return `<span class="price-from">From</span> <strong>${formatPrice(basePrice)}</strong> <del class="price-strike">${formatPrice(original)}</del>`;
}

function pexelsUrl(id, ext, w) {
  ext = ext || "jpeg";
  w = w || 500;
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.${ext}?auto=compress&cs=tinysrgb&w=${w}`;
}

function getProductImages(product, w) {
  return product.images.map((id) => pexelsUrl(id, product.ext, w));
}

function getProductById(id) {
  return CATALOG.find((p) => p.id === Number(id));
}

function getCategorySlug(category) {
  const map = {
    "Hand Dryers": "handdryers", "Automatic Taps": "taps", "Soap Dispensers": "dispensers",
    "Sensor Flushers": "sensors", "Entrance Automation": "entrance", "Accessories": "accessories"
  };
  return map[category] || "";
}
