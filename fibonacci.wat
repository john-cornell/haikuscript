(module
  (global $rng (mut i32) (i32.const 1226523956))
  (func $next_random (result i32) (local $s i32)
    global.get $rng local.set $s
    local.get $s local.get $s i32.const 13 i32.shl i32.xor local.set $s
    local.get $s local.get $s i32.const 17 i32.shr_u i32.xor local.set $s
    local.get $s local.get $s i32.const 5 i32.shl i32.xor local.set $s
    local.get $s global.set $rng
    local.get $s i32.const 100 i32.rem_u)
  (func $compute (result i32)
    (local $x i32) (local $y i32) (local $z i32) (local $count i32)

  i32.const 0
  local.set $x
  i32.const 1
  local.set $y
  i32.const 0
  local.set $count
  block
  loop
    local.get $count
    i32.const 10
    i32.eq
    br_if 1
    local.get $x
    local.set $z
    local.get $z
    local.get $y
    i32.add
    local.set $z
    local.get $y
    local.set $x
    local.get $z
    local.set $y
    local.get $count
    i32.const 1
    i32.add
    local.set $count
    br 0
  end
  end

    local.get $x
  )
  (export "compute" (func $compute))
)