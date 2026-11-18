# Security Specification - Undercover Game

## Data Invariants
1. **User Ownership**: A user document (`/users/{userId}`) can only be created or modified by the user with the matching `uid`.
2. **Room Creation Authenticity**: A room can only be created by an authenticated user who is set as the `hostId`.
3. **Room Membership**: Only the host or existing players in the `players` list can modify a room's state (joining, readying, starting game).
4. **Immutability of IDs**: Sensitive fields like `hostId` in a room and `uid` in a user profile must remain unchanged after creation.
5. **Terminal State**: Once a room's `status` is set to `finished`, no further modifications are allowed to the room state.
6. **Interaction Isolation**: Friend requests can only be initiated by the sender and responded to by the receiver.

## The "Dirty Dozen" Payloads (Deny Cases)
1. **Identity Spoofing**: Attempting to create a user profile with a different `auth.uid`.
2. **Ghost Field Injection**: Adding an `isAdmin` field to a user profile or room.
3. **Invalid ID Poisoning**: Using extremely long or malicious characters as a document ID.
4. **Self-Promotion**: Non-host user attempting to change the room `status` to `playing` without using allowed update paths.
5. **State Shortcut**: Changing room `status` from `waiting` directly to `finished`.
6. **Resource Exhaustion**: Sending a room description or player name that is 1MB in size.
7. **Orphaned Write**: Creating a friend request to a non-existent user.
8. **Privilege Escalation**: A player attempting to remove the host from the room.
9. **Timestamp Manipulation**: Providing a client-side `createdAt` date instead of `request.time`.
10. **Terminal Bypass**: Trying to update a `finished` game room.
11. **PII Leak**: A stranger attempting to list all user profiles with sensitive fields.
12. **Foreign Join**: Joining a room after it has already started (`playing` status).

## Test Runner (Verification)
The `firestore.rules.test.ts` file will verify these denial cases using the Firebase Rules Emulator.
