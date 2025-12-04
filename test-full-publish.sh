#!/bin/bash
set -e

echo "🔍 TEST DE PUBLICATION COMPLET - better-ccusage"
echo "================================================"
echo ""

# 1. Nettoyer les anciens build
echo "1️⃣  Nettoyage des anciens builds..."
echo "==================================="
cd apps/better-ccusage
rm -rf dist node_modules/.tsbuildinfo

cd ../..

# 2. Vérifier les imports en simulant pnpm pack
echo ""
echo "2️⃣  Vérification des imports avec tsx..."
echo "========================================"
cd apps/better-ccusage

# Tester l'import principal pour vérifier les dépendances
echo "Test d'import principal..."
node --loader tsx/esm --input-type=module -e "import('./src/index.ts').then(() => console.log('✅ Import réussi')).catch(e => { console.error('❌ Erreur:', e.message); process.exit(1) })" || exit 1

cd ../..

# 3. Simuler le prepack
echo ""
echo "3️⃣  Simulation du prepack..."
echo "============================"
cd apps/better-ccusage

echo "Génération du schema..."
pnpm run generate:schema || exit 1

echo "Build avec tsdown..."
pnpm tsdown || exit 1

echo "Copie du fichier de pricing..."
cp model_prices_and_context_window.json dist/ || exit 1

# 4. Test de pnpm pack
echo ""
echo "4️⃣  Test de pnpm pack..."
echo "========================"
pnpm pack --pack-destination /tmp || exit 1

# 5. Nettoyage
echo ""
echo "5️⃣  Nettoyage..."
echo "================"
rm -f /tmp/better-ccusage-*.tgz

echo ""
echo "✅ TOUS LES TESTS ONT RÉUSSI !"
echo "Le paquet est prêt pour la publication."
