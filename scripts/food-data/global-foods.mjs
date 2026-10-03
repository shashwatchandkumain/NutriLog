// The starting Global Food Database. `npm run build:food-seed` turns this list into
// supabase/migrations/006_global_foods_seed.sql.
//
// Every food takes its nutrition from a real source — nothing here is estimated:
//   usda: an FDC id from USDA FoodData Central, SR Legacy (public domain): macros, sugar, fats,
//         sodium, cholesterol, vitamins and minerals per 100 g.
//   ref:  a row of NutriLog's curated reference table (supabase/functions/_shared/reference-foods.ts;
//         IFCT 2017 / USDA / Indian labels) — mainly Indian dishes USDA doesn't cover. Macros only;
//         micronutrients stay unknown (null), never zero.
// servings: [label, grams] pairs, the first one is the default for "2 eggs"-style counts. When
// omitted they come from the reference row's portions, or USDA's measured portions.
// aliases: other names people type or say (English, Hindi, Hinglish); matching ignores case,
// punctuation, plurals and word order.

export const GLOBAL_FOODS = [
  // ── Eggs ──────────────────────────────────────────────────────────────
  { name: 'Boiled egg', category: 'eggs', prep: 'boiled', usda: 173424, aliases: ['egg', 'boiled egg', 'hard boiled egg', 'anda', 'boiled anda', 'ubla anda', 'egg boiled', 'whole egg boiled'],
    servings: [['1 large egg', 50], ['1 medium egg', 44], ['1 small egg', 38]] },
  { name: 'Raw egg', category: 'eggs', prep: 'raw', usda: 171287, aliases: ['egg raw', 'kacha anda'], servings: [['1 large egg', 50], ['1 medium egg', 44]] },
  { name: 'Fried egg', category: 'eggs', prep: 'fried', usda: 173423, aliases: ['egg fry', 'fried eggs', 'sunny side up', 'bullseye', 'half fried egg', 'half fry', 'half fry egg', 'half-fried egg'],
    servings: [['1 fried egg', 46]] },
  { name: 'Scrambled egg', category: 'eggs', prep: 'scrambled', usda: 172187, aliases: ['scrambled eggs', 'egg bhurji', 'anda bhurji', 'bhurji'], servings: [['2 eggs, scrambled', 120], ['1 egg, scrambled', 61]] },
  { name: 'Omelette', category: 'eggs', prep: 'omelette', usda: 172185, aliases: ['omelet', 'egg omelette', 'masala omelette', 'anda omelette'], servings: [['2-egg omelette', 120], ['1-egg omelette', 60]] },
  { name: 'Poached egg', category: 'eggs', prep: 'poached', usda: 172186, aliases: ['egg poached'], servings: [['1 large egg', 50]] },
  { name: 'Egg white', category: 'eggs', usda: 172183, aliases: ['egg whites', 'anda safedi'], servings: [['1 egg white', 33]] },
  { name: 'Egg yolk', category: 'eggs', usda: 172184, aliases: ['yolk', 'anda zardi'], servings: [['1 yolk', 17]] },

  // ── Meat, fish, protein ───────────────────────────────────────────────
  { name: 'Chicken breast, cooked', category: 'protein', prep: 'cooked', usda: 171477, aliases: ['chicken breast', 'grilled chicken breast', 'chicken breast grilled', 'roasted chicken breast', 'boiled chicken breast', 'grilled chicken'],
    servings: [['1 piece (palm size)', 100], ['1 whole breast', 170]] },
  { name: 'Chicken breast, raw', category: 'protein', prep: 'raw', ref: 'Chicken breast, raw (skinless)', aliases: ['raw chicken breast'] },
  { name: 'Chicken thigh, cooked', category: 'protein', prep: 'cooked', usda: 172388, aliases: ['chicken thigh', 'chicken leg piece'], servings: [['1 thigh', 75]] },
  { name: 'Mutton, cooked', category: 'protein', prep: 'cooked', ref: 'Mutton / goat meat, cooked', aliases: ['mutton', 'goat meat', 'gosht'] },
  { name: 'Mutton curry', category: 'curry', ref: 'Mutton curry', aliases: ['mutton gravy', 'gosht curry'] },
  { name: 'Fish, cooked (lean)', category: 'protein', prep: 'cooked', usda: 175177, aliases: ['fish', 'tilapia', 'rohu', 'machli', 'fish fillet'], servings: [['1 piece', 100]] },
  { name: 'Salmon, cooked', category: 'protein', prep: 'cooked', usda: 175168, aliases: ['salmon'], servings: [['1 fillet', 150]] },
  { name: 'Tuna, canned in water', category: 'protein', usda: 173709, aliases: ['tuna', 'canned tuna'], servings: [['1 can (drained)', 140]] },
  { name: 'Prawns, cooked', category: 'protein', prep: 'cooked', usda: 175180, aliases: ['prawns', 'shrimp', 'jhinga'], servings: [['1 serving', 100]] },
  { name: 'Paneer', category: 'dairy', ref: 'Paneer (full fat)', aliases: ['cottage cheese indian', 'paneer cubes'] },
  { name: 'Tofu', category: 'protein', usda: 172448, aliases: ['tofu firm', 'firm tofu'], servings: [['1 serving', 100]] },
  { name: 'Soya chunks (dry)', category: 'protein', ref: 'Soya chunks (dry)', aliases: ['soya chunks', 'soya badi', 'nutrela', 'soy chunks'] },
  { name: 'Whey protein', category: 'protein', usda: 173180, aliases: ['whey', 'protein powder', 'whey protein powder', 'protein shake powder'], servings: [['1 scoop', 30]] },

  // ── Grains, breads ────────────────────────────────────────────────────
  { name: 'Roti', category: 'grains', ref: 'Roti / Chapati (whole wheat, no ghee)', aliases: ['chapati', 'chapatti', 'chappati', 'phulka', 'fulka', 'indian roti', 'wheat roti', 'tawa roti'],
    servings: [['1 medium roti', 40], ['1 small roti / phulka', 30], ['1 large roti', 55]] },
  { name: 'Rice, white, cooked', category: 'grains', prep: 'cooked', usda: 169757, aliases: ['rice', 'white rice', 'chawal', 'boiled rice', 'steamed rice', 'plain rice', 'cooked rice'],
    servings: [['1 katori (bowl)', 150], ['1 cup', 158], ['1 plate', 250]] },
  { name: 'Rice, brown, cooked', category: 'grains', prep: 'cooked', usda: 169704, aliases: ['brown rice'], servings: [['1 katori (bowl)', 150], ['1 cup', 195]] },
  { name: 'Naan', category: 'grains', ref: 'Naan, plain', aliases: ['plain naan', 'nan'] },
  { name: 'White bread', category: 'grains', usda: 174924, aliases: ['bread', 'bread slice', 'white bread slice', 'sandwich bread'], servings: [['1 slice', 25]] },
  { name: 'Brown bread', category: 'grains', usda: 172688, aliases: ['whole wheat bread', 'wheat bread', 'brown bread slice', 'atta bread'], servings: [['1 slice', 28]] },
  { name: 'Oats (dry)', category: 'grains', usda: 173904, aliases: ['oats', 'rolled oats', 'oatmeal dry', 'oat'], servings: [['1/2 cup', 40], ['1 tbsp', 5]] },
  { name: 'Oatmeal, cooked with water', category: 'grains', prep: 'cooked', ref: 'Oatmeal / porridge, cooked with water', aliases: ['oatmeal', 'porridge', 'oats porridge', 'cooked oats'] },
  { name: 'Cornflakes', category: 'grains', ref: 'Cornflakes (dry)', aliases: ['corn flakes'] },
  { name: 'Pasta, cooked', category: 'grains', prep: 'cooked', usda: 168928, aliases: ['pasta', 'spaghetti', 'macaroni'], servings: [['1 cup', 140]] },
  { name: 'Quinoa, cooked', category: 'grains', prep: 'cooked', usda: 168917, aliases: ['quinoa'], servings: [['1 cup', 185]] },
  { name: 'Instant noodles (dry)', category: 'grains', ref: 'Instant noodles, masala (dry weight)', aliases: ['maggi', 'instant noodles', 'masala noodles'] },
  { name: 'Poha', category: 'breakfast', ref: 'Poha, cooked (tempered)', aliases: ['kanda poha', 'aloo poha', 'chivda poha'] },
  { name: 'Dosa', category: 'breakfast', ref: 'Dosa, plain', aliases: ['plain dosa', 'sada dosa'] },
  { name: 'Khichdi', category: 'grains', ref: 'Khichdi (rice + moong dal)', aliases: ['khichri', 'moong dal khichdi'] },

  // ── Dals, legumes ─────────────────────────────────────────────────────
  { name: 'Dal', category: 'dal', ref: 'Dal, cooked (plain, medium consistency)', aliases: ['daal', 'dhal', 'plain dal', 'arhar dal', 'toor dal', 'yellow dal', 'moong dal'] },
  { name: 'Dal tadka', category: 'dal', ref: 'Dal tadka / dal fry', aliases: ['dal fry', 'tadka dal', 'daal tadka', 'dal tarka'] },
  { name: 'Moong, boiled', category: 'dal', prep: 'boiled', usda: 174257, aliases: ['boiled moong', 'mung beans boiled', 'green gram boiled'], servings: [['1 katori (bowl)', 150]] },
  { name: 'Lentils, boiled', category: 'dal', prep: 'boiled', usda: 172421, aliases: ['masoor', 'boiled masoor', 'lentils', 'red lentils boiled'], servings: [['1 katori (bowl)', 150]] },
  { name: 'Chickpeas, boiled', category: 'dal', prep: 'boiled', usda: 173757, aliases: ['chana', 'boiled chana', 'kabuli chana', 'chickpeas', 'chole boiled'], servings: [['1 katori (bowl)', 150], ['1 cup', 164]] },
  { name: 'Chole', category: 'curry', ref: 'Chole / chana masala', aliases: ['chana masala', 'chhole', 'chole masala'] },
  { name: 'Rajma, boiled', category: 'dal', prep: 'boiled', usda: 173740, aliases: ['rajma', 'kidney beans', 'boiled rajma'], servings: [['1 katori (bowl)', 150]] },
  { name: 'Moong sprouts', category: 'dal', usda: 169957, aliases: ['sprouts', 'sprouted moong', 'mung sprouts'], servings: [['1 cup', 104]] },
  { name: 'Roasted chana', category: 'snack', ref: 'Roasted chana (bhuna chana)', aliases: ['bhuna chana', 'roasted gram', 'chana roasted'] },

  // ── Dairy, fats ───────────────────────────────────────────────────────
  { name: 'Milk, whole', category: 'dairy', usda: 171265, aliases: ['milk', 'full cream milk', 'full fat milk', 'doodh', 'cow milk'], servings: [['1 glass', 250], ['1 cup', 240]], unit: 'ml' },
  { name: 'Milk, toned', category: 'dairy', ref: 'Milk, toned (3% fat)', aliases: ['toned milk'] },
  { name: 'Milk, double toned', category: 'dairy', ref: 'Milk, double toned (1.5% fat)', aliases: ['double toned milk', 'low fat milk'] },
  { name: 'Milk, skimmed', category: 'dairy', usda: 171269, aliases: ['skim milk', 'skimmed milk', 'fat free milk'], servings: [['1 glass', 250], ['1 cup', 240]], unit: 'ml' },
  { name: 'Milk, buffalo', category: 'dairy', ref: 'Milk, buffalo', aliases: ['buffalo milk', 'bhains ka doodh'] },
  { name: 'Curd', category: 'dairy', usda: 171284, aliases: ['dahi', 'yogurt', 'yoghurt', 'plain curd', 'plain yogurt'], servings: [['1 katori (bowl)', 150], ['1 cup', 245]] },
  { name: 'Greek yogurt, plain, non-fat', category: 'dairy', usda: 170894, aliases: ['greek yogurt', 'hung curd'], servings: [['1 cup', 170]] },
  { name: 'Cheese slice', category: 'dairy', usda: 171290, aliases: ['cheese', 'processed cheese', 'cheese slices', 'amul cheese slice'], servings: [['1 slice', 20]] },
  { name: 'Butter', category: 'fats', usda: 173430, aliases: ['makhan', 'unsalted butter', 'salted butter', 'white butter'], servings: [['1 tsp', 5], ['1 tbsp', 14]] },
  { name: 'Ghee', category: 'fats', usda: 173412, aliases: ['desi ghee', 'clarified butter'], servings: [['1 tsp', 5], ['1 tbsp', 13]] },
  { name: 'Cooking oil', category: 'fats', usda: 172370, aliases: ['oil', 'vegetable oil', 'refined oil', 'sunflower oil', 'soybean oil', 'mustard oil'], servings: [['1 tsp', 4.5], ['1 tbsp', 13.6]] },
  { name: 'Lassi, sweet', category: 'drinks', ref: 'Lassi, sweet', aliases: ['lassi', 'sweet lassi'] },
  { name: 'Buttermilk', category: 'drinks', ref: 'Chaas / buttermilk (salted)', aliases: ['chaas', 'chhach', 'mattha', 'salted buttermilk'] },

  // ── Vegetables ────────────────────────────────────────────────────────
  { name: 'Potato, boiled', category: 'vegetables', prep: 'boiled', usda: 170440, aliases: ['potato', 'aloo', 'boiled potato', 'boiled aloo'], servings: [['1 medium potato', 150]] },
  { name: 'Sweet potato, boiled', category: 'vegetables', prep: 'boiled', usda: 168484, aliases: ['sweet potato', 'shakarkandi'], servings: [['1 medium', 150]] },
  { name: 'Onion', category: 'vegetables', usda: 170000, aliases: ['pyaz', 'pyaaz', 'onions', 'raw onion'], servings: [['1 medium onion', 110]] },
  { name: 'Tomato', category: 'vegetables', usda: 170457, aliases: ['tamatar', 'tomatoes', 'raw tomato'], servings: [['1 medium tomato', 120]] },
  { name: 'Cucumber', category: 'vegetables', usda: 168409, aliases: ['kheera', 'khira', 'cucumbers'], servings: [['1 medium', 200], ['1 cup sliced', 120]] },
  { name: 'Carrot', category: 'vegetables', usda: 170393, aliases: ['gajar', 'carrots'], servings: [['1 medium carrot', 60]] },
  { name: 'Spinach', category: 'vegetables', usda: 168462, aliases: ['palak', 'raw spinach'], servings: [['1 cup', 30]] },
  { name: 'Broccoli', category: 'vegetables', usda: 170379, aliases: [], servings: [['1 cup chopped', 91]] },
  { name: 'Green peas, cooked', category: 'vegetables', prep: 'cooked', usda: 170420, aliases: ['peas', 'matar', 'green peas'], servings: [['1 katori (bowl)', 100]] },
  { name: 'Sweet corn, cooked', category: 'vegetables', prep: 'cooked', usda: 169999, aliases: ['corn', 'sweet corn', 'bhutta', 'makka'], servings: [['1 cup', 145], ['1 cob', 100]] },

  // ── Fruit ─────────────────────────────────────────────────────────────
  { name: 'Banana', category: 'fruit', usda: 173944, aliases: ['kela', 'bananas'], servings: [['1 medium banana', 118], ['1 small banana', 101], ['1 large banana', 136]] },
  { name: 'Apple', category: 'fruit', usda: 171688, aliases: ['seb', 'apples'], servings: [['1 medium apple', 182]] },
  { name: 'Mango', category: 'fruit', usda: 169910, aliases: ['aam', 'mangoes'], servings: [['1 medium mango (edible part)', 200], ['1 cup sliced', 165]] },
  { name: 'Orange', category: 'fruit', usda: 169097, aliases: ['santra', 'narangi', 'oranges'], servings: [['1 medium orange', 131]] },
  { name: 'Papaya', category: 'fruit', usda: 169926, aliases: ['papita'], servings: [['1 cup cubes', 145]] },
  { name: 'Grapes', category: 'fruit', usda: 174683, aliases: ['angoor', 'grape'], servings: [['1 cup', 151]] },
  { name: 'Watermelon', category: 'fruit', usda: 167765, aliases: ['tarbooz', 'tarbuj'], servings: [['1 cup diced', 152]] },
  { name: 'Guava', category: 'fruit', usda: 173044, aliases: ['amrood', 'amrud'], servings: [['1 guava', 55]] },
  { name: 'Pomegranate', category: 'fruit', usda: 169134, aliases: ['anar', 'pomegranate seeds'], servings: [['1/2 cup arils', 87]] },
  { name: 'Pineapple', category: 'fruit', usda: 169124, aliases: ['ananas'], servings: [['1 cup chunks', 165]] },
  { name: 'Pear', category: 'fruit', usda: 169118, aliases: ['nashpati', 'pears'], servings: [['1 medium pear', 178]] },
  { name: 'Strawberries', category: 'fruit', usda: 167762, aliases: ['strawberry'], servings: [['1 cup', 152]] },
  { name: 'Dates', category: 'fruit', usda: 168191, aliases: ['khajoor', 'khajur', 'medjool dates'], servings: [['1 medjool date', 24]] },

  // ── Nuts, seeds ───────────────────────────────────────────────────────
  { name: 'Almonds', category: 'nuts', usda: 170567, aliases: ['badam', 'almond'], servings: [['10 almonds', 12], ['1 handful', 28]] },
  { name: 'Peanuts, roasted', category: 'nuts', prep: 'roasted', usda: 173806, aliases: ['peanuts', 'moongphali', 'mungfali', 'roasted peanuts', 'groundnuts'], servings: [['1 handful', 28], ['1 tbsp', 9]] },
  { name: 'Peanut butter', category: 'nuts', usda: 172470, aliases: [], servings: [['1 tbsp', 16]] },
  { name: 'Cashews', category: 'nuts', usda: 170162, aliases: ['kaju', 'cashew', 'cashew nuts'], servings: [['10 cashews', 15], ['1 handful', 28]] },
  { name: 'Walnuts', category: 'nuts', usda: 170187, aliases: ['akhrot', 'walnut'], servings: [['1 handful', 28]] },
  { name: 'Chia seeds', category: 'nuts', usda: 170554, aliases: ['chia'], servings: [['1 tbsp', 12]] },
  { name: 'Flax seeds', category: 'nuts', usda: 169414, aliases: ['flaxseed', 'alsi', 'linseed'], servings: [['1 tbsp', 10]] },
  { name: 'Makhana, roasted', category: 'nuts', prep: 'roasted', ref: 'Makhana (fox nuts), roasted', aliases: ['makhana', 'fox nuts', 'lotus seeds'] },

  // ── Sweeteners ────────────────────────────────────────────────────────
  { name: 'Sugar', category: 'sweeteners', usda: 169655, aliases: ['cheeni', 'chini', 'white sugar'], servings: [['1 tsp', 4], ['1 tbsp', 12.5]] },
  { name: 'Jaggery', category: 'sweeteners', ref: 'Jaggery', aliases: ['gur', 'gud'] },
  { name: 'Honey', category: 'sweeteners', usda: 169640, aliases: ['shahad', 'shehad'], servings: [['1 tsp', 7], ['1 tbsp', 21]] },

  // ── Snacks, sweets ────────────────────────────────────────────────────
  { name: 'Samosa', category: 'snack', prep: 'fried', ref: 'Samosa (potato)', aliases: ['aloo samosa', 'samosas'] },
  { name: 'Pakora', category: 'snack', prep: 'fried', ref: 'Pakora / bhaji (onion or mixed veg)', aliases: ['pakoda', 'bhajiya', 'bhaji', 'onion pakora'] },
  { name: 'Poori', category: 'grains', prep: 'fried', ref: 'Poori', aliases: ['puri'] },
  { name: 'Bhatura', category: 'grains', prep: 'fried', ref: 'Bhatura', aliases: ['bhature'] },
  { name: 'Medu vada', category: 'breakfast', prep: 'fried', ref: 'Medu vada', aliases: ['vada', 'vadai', 'uddin vada'] },
  { name: 'Kachori', category: 'snack', prep: 'fried', ref: 'Kachori', aliases: ['kachauri'] },
  { name: 'Vada pav', category: 'snack', ref: 'Vada pav', aliases: ['wada pav', 'vadapav'] },
  { name: 'Dhokla', category: 'snack', ref: 'Dhokla', aliases: ['khaman dhokla', 'khaman'] },
  { name: 'Gulab jamun', category: 'sweets', ref: 'Gulab jamun (with syrup)', aliases: ['gulabjamun'] },
  { name: 'Jalebi', category: 'sweets', ref: 'Jalebi', aliases: ['jilebi'] },
  { name: 'Marie biscuit', category: 'snack', ref: 'Biscuit, glucose / Marie type', aliases: ['biscuit', 'glucose biscuit', 'parle g', 'marie'] },
  { name: 'Potato chips', category: 'snack', ref: 'Potato chips', aliases: ['chips', 'wafers', 'lays'] },

  // ── Drinks ────────────────────────────────────────────────────────────
  { name: 'Chai with sugar', category: 'drinks', ref: 'Tea (chai) with milk and sugar', aliases: ['chai', 'tea', 'masala chai', 'milk tea', 'tea with sugar', 'chai with milk and sugar'] },
  { name: 'Chai without sugar', category: 'drinks', ref: 'Tea with milk, no sugar', aliases: ['tea without sugar', 'chai no sugar', 'sugar free chai', 'chai without cheeni'] },
  { name: 'Coffee with milk and sugar', category: 'drinks', ref: 'Coffee with milk and sugar', aliases: ['coffee', 'milk coffee', 'filter coffee'] },
  { name: 'Black coffee', category: 'drinks', usda: 171890, aliases: ['coffee black', 'black coffee no sugar', 'americano'], servings: [['1 cup', 240]], unit: 'ml' },
  { name: 'Cola', category: 'drinks', usda: 174852, aliases: ['coke', 'pepsi', 'soft drink', 'cold drink', 'thums up'], servings: [['1 can', 330], ['1 glass', 250]], unit: 'ml' },
  { name: 'Orange juice', category: 'drinks', usda: 169098, aliases: ['orange juice fresh', 'santra juice'], servings: [['1 glass', 250]], unit: 'ml' },
  { name: 'Coconut water', category: 'drinks', ref: 'Coconut water', aliases: ['nariyal pani', 'tender coconut water'] },
];
