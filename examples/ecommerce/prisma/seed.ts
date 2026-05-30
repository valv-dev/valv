import "dotenv/config"
import { PrismaClient, UserRole, OrderStatus } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
  // Delete in dependency order for idempotency
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.product.deleteMany()
  await prisma.user.deleteMany()

  // ── Users ────────────────────────────────────────────────────────────────
  const alice = await prisma.user.create({
    data: {
      id: "user-alice",
      name: "Alice Admin",
      email: "alice@alpha.com",
      password_hash: "$2b$10$hashed_alice",
      role: UserRole.admin,
      tenant_id: "tenant-alpha",
    },
  })

  const bob = await prisma.user.create({
    data: {
      id: "user-bob",
      name: "Bob Support",
      email: "bob@alpha.com",
      password_hash: "$2b$10$hashed_bob",
      role: UserRole.support,
      tenant_id: "tenant-alpha",
    },
  })

  const carol = await prisma.user.create({
    data: {
      id: "user-carol",
      name: "Carol Admin",
      email: "carol@beta.com",
      password_hash: "$2b$10$hashed_carol",
      role: UserRole.admin,
      tenant_id: "tenant-beta",
    },
  })

  // ── tenant-alpha products ─────────────────────────────────────────────────
  const laptop = await prisma.product.create({
    data: {
      id: "prod-laptop",
      name: "Pro Laptop",
      description: "High-performance laptop",
      price: 129999,
      stock: 10,
      tenant_id: "tenant-alpha",
    },
  })

  const headset = await prisma.product.create({
    data: {
      id: "prod-headset",
      name: "Studio Headset",
      description: "Professional audio headset",
      price: 24999,
      stock: 0,
      tenant_id: "tenant-alpha",
    },
  })

  const keyboard = await prisma.product.create({
    data: {
      id: "prod-keyboard",
      name: "Mechanical Keyboard",
      description: "Tactile mechanical keyboard",
      price: 14999,
      stock: 25,
      tenant_id: "tenant-alpha",
    },
  })

  const mouse = await prisma.product.create({
    data: {
      id: "prod-mouse",
      name: "Wireless Mouse",
      description: "Ergonomic wireless mouse",
      price: 7999,
      stock: 42,
      tenant_id: "tenant-alpha",
    },
  })

  // ── tenant-beta products ──────────────────────────────────────────────────
  const tablet = await prisma.product.create({
    data: {
      id: "prod-beta-tablet",
      name: "Beta Tablet",
      description: "Tablet exclusive to tenant-beta",
      price: 49999,
      stock: 5,
      tenant_id: "tenant-beta",
    },
  })

  const monitor = await prisma.product.create({
    data: {
      id: "prod-beta-monitor",
      name: "Beta Monitor",
      description: "4K monitor for tenant-beta",
      price: 39999,
      stock: 8,
      tenant_id: "tenant-beta",
    },
  })

  // ── tenant-alpha orders ───────────────────────────────────────────────────
  // Order 1: alice's delivered order — has internal_notes to prove they never leak
  const order1 = await prisma.order.create({
    data: {
      id: "order-1",
      status: OrderStatus.delivered,
      total: 154998,
      internal_notes: "Flagged for review — chargeback risk",
      tenant_id: "tenant-alpha",
      user_id: alice.id,
    },
  })

  // Order 2: alice's pending order
  const order2 = await prisma.order.create({
    data: {
      id: "order-2",
      status: OrderStatus.pending,
      total: 129999,
      tenant_id: "tenant-alpha",
      user_id: alice.id,
    },
  })

  // Order 3: alice's delivered order — second delivery to make analytics interesting
  const order3 = await prisma.order.create({
    data: {
      id: "order-3",
      status: OrderStatus.delivered,
      total: 22998,
      tenant_id: "tenant-alpha",
      user_id: alice.id,
    },
  })

  // Order 4: bob's processing order
  const order4 = await prisma.order.create({
    data: {
      id: "order-4",
      status: OrderStatus.processing,
      total: 24999,
      tenant_id: "tenant-alpha",
      user_id: bob.id,
    },
  })

  // ── tenant-beta orders ────────────────────────────────────────────────────
  // These must NEVER appear in tenant-alpha queries — the cross-tenant isolation test checks this.
  const order5 = await prisma.order.create({
    data: {
      id: "order-5",
      status: OrderStatus.delivered,
      total: 89998,
      internal_notes: "Beta tenant priority order",
      tenant_id: "tenant-beta",
      user_id: carol.id,
    },
  })

  const order6 = await prisma.order.create({
    data: {
      id: "order-6",
      status: OrderStatus.shipped,
      total: 39999,
      tenant_id: "tenant-beta",
      user_id: carol.id,
    },
  })

  // ── Order items ───────────────────────────────────────────────────────────
  await prisma.orderItem.createMany({
    data: [
      // tenant-alpha
      { order_id: order1.id, product_id: laptop.id,   quantity: 1, unit_price: 129999 },
      { order_id: order1.id, product_id: headset.id,  quantity: 1, unit_price: 24999  },
      { order_id: order2.id, product_id: laptop.id,   quantity: 1, unit_price: 129999 },
      { order_id: order3.id, product_id: keyboard.id, quantity: 1, unit_price: 14999  },
      { order_id: order3.id, product_id: mouse.id,    quantity: 1, unit_price: 7999   },
      { order_id: order4.id, product_id: headset.id,  quantity: 1, unit_price: 24999  },
      // tenant-beta
      { order_id: order5.id, product_id: tablet.id,   quantity: 1, unit_price: 49999  },
      { order_id: order5.id, product_id: monitor.id,  quantity: 1, unit_price: 39999  },
      { order_id: order6.id, product_id: monitor.id,  quantity: 1, unit_price: 39999  },
    ],
  })

  console.log("Seed complete:")
  console.log("  tenant-alpha: alice (admin), bob (support), 4 products, 4 orders")
  console.log("  tenant-beta:  carol (admin), 2 products, 2 orders (must not leak across tenant boundary)")
}

main()
  .catch((err) => {
    console.error("Seed failed:", err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
