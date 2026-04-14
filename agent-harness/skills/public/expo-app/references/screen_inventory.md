# Screen Inventory — IVISH Reference Architecture

This document catalogs all 41 screens from the IVISH app, organized by navigation flow. Use this as a reference when building apps with similar complexity.

## Navigation Architecture

```
RootStack (NativeStackNavigator)
├── Onboarding Flow (7 screens)
├── MainTabs (BottomTabNavigator — 4 tabs + 1 action button)
│   ├── Home
│   ├── Events
│   ├── Send (custom floating button → ChooseRecipient)
│   ├── Wallet
│   └── Profile
├── Gifting Flow (13 screens, pushed on top of tabs)
├── Events Flow (2 screens)
├── Finance Flow (2 screens)
├── Settings Flow (11 screens)
└── Aliases (6 backward-compatibility redirects)
```

## Onboarding Flow (7 screens)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Splash | `SplashScreen.tsx` | `Splash` | App launch animation, auto-navigates to Onboarding |
| Onboarding Step 1 | `OnboardingScreen.tsx` | `Onboarding` | Value prop: "Send gifts instantly" |
| Onboarding Step 2 | `OnboardingStep2Screen.tsx` | `OnboardingStep2` | Value prop: "Beautiful digital cards" |
| Onboarding Step 3 | `OnboardingStep3Screen.tsx` | `OnboardingStep3` | Value prop: "Powered by crypto" |
| Login | `LoginScreen.tsx` | `Login` | Phone number entry |
| OTP Verification | `OTPScreen.tsx` | `OTP` | 6-digit code entry with auto-advance |
| Phone Verification | `VerifyPhoneScreen.tsx` | `VerifyPhone` | Phone verification during onboarding |

**Navigation flow:** Splash → Onboarding → Step2 → Step3 → Login → OTP → MainTabs
**Skip shortcut:** Any onboarding screen → MainTabs

## Main Tab Screens (5 screens)

| Screen | File | Tab | Icon | Purpose |
|--------|------|-----|------|---------|
| Home | `HomeScreen.tsx` | Home | `home` | Dashboard with balance, recent activity, quick actions |
| Events List | `EventsListScreen.tsx` | Events | `calendar` | Upcoming and past events |
| Choose Recipient | `ChooseRecipientScreen.tsx` | Send | `gift` (custom button) | Contact picker for sending gifts |
| Wallet | `WalletScreen.tsx` | Wallet | `wallet` | Balance, transactions, add/cash out |
| Profile | `ProfileScreen.tsx` | Profile | `person` | User info, menu to settings |

## Gifting Flow (13 screens)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Choose Recipient | `ChooseRecipientScreen.tsx` | `ChooseRecipient` | Select contact from list or search |
| Send Gift | `SendGiftScreen.tsx` | `SendGift` | Gift configuration (amount, card, message) |
| Send Gift Amount | `SendGiftAmountScreen.tsx` | `SendGiftAmount` | Amount entry with quick-select chips ($25, $50, $100) |
| Select Card | `SelectCardScreen.tsx` | `SelectCard` | Greeting card template picker with category filters |
| Card Customizer | `CardCustomizerScreen.tsx` | `CardCustomizer` | Edit card text, colors, add personal message |
| Gift Preview | `GiftPreviewScreen.tsx` | `GiftPreview` | Final review before sending |
| Gift Success | `GiftSuccessScreen.tsx` | `GiftSuccess` | Confirmation with confetti animation |
| Gift Received | `GiftReceivedScreen.tsx` | `GiftReceived` | Recipient view of incoming gift |
| Gift History | `GiftHistoryScreen.tsx` | `GiftHistory` | List of sent and received gifts |
| Gift Detail | `GiftDetailScreen.tsx` | `GiftDetail` | Individual gift transaction details |
| Group Gift | `GroupGiftScreen.tsx` | `GroupGift` | Group gift pool with progress bar |
| Contribute to Gift | `ContributeToGiftScreen.tsx` | `ContributeToGift` | Add contribution to group gift |
| Send Thank You | `SendThankYouScreen.tsx` | `SendThankYou` | Compose thank-you note to gift sender |

**Primary flow:** ChooseRecipient → SendGiftAmount → SelectCard → CardCustomizer → GiftPreview → GiftSuccess
**Alternative flows:** GiftHistory → GiftDetail, GroupGift → ContributeToGift

## Events Flow (2 screens)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Create Event | `CreateEventScreen.tsx` | `CreateEvent` | Event creation form (title, date, location, type) |
| Event Detail | `EventDetailScreen.tsx` | `EventDetail` | Event info, guest list, gift summary |

## Finance Flow (2 screens)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Add Funds | `AddFundsScreen.tsx` | `AddFunds` | Onramp: bank/card → USDC via Coinbase |
| Cash Out | `CashOutScreen.tsx` | `CashOut` | Offramp: USDC → bank account |

## Settings Flow (11 screens)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Settings Hub | `SettingsScreen.tsx` | `Settings` | Settings menu with categorized options |
| Edit Profile | `EditProfileScreen.tsx` | `EditProfile` | Name, email, phone, avatar |
| Security | `SecurityScreen.tsx` | `Security` | Biometrics, PIN, 2FA settings |
| Change PIN | `ChangePinScreen.tsx` | `ChangePin` | PIN change flow with numeric keypad |
| Payment Methods | `PaymentMethodsScreen.tsx` | `PaymentMethods` | Linked cards and bank accounts |
| Add Payment | `AddPaymentScreen.tsx` | `AddPayment` | Add new card or bank account |
| Notification Prefs | `NotificationPrefsScreen.tsx` | `NotificationPrefs` | Push notification toggles |
| Notifications | `NotificationsScreen.tsx` | `Notifications` | Notification inbox |
| Appearance | `AppearanceScreen.tsx` | `Appearance` | Theme toggle, font size, app icon |
| Language | `LanguageScreen.tsx` | `Language` | Language preference selection |
| Help Center | `HelpCenterScreen.tsx` | `HelpCenter` | FAQ categories and support contact |

## Legal Screens (2 screens, part of Settings)

| Screen | File | Route Name | Purpose |
|--------|------|------------|---------|
| Privacy Policy | `PrivacyPolicyScreen.tsx` | `PrivacyPolicy` | Privacy policy display |
| Terms of Service | `TermsOfServiceScreen.tsx` | `TermsOfService` | Terms of service display |

## Backward-Compatibility Aliases (6 redirects)

| Alias Route | Points To | Reason |
|-------------|-----------|--------|
| `SignIn` | `LoginScreen` | Legacy naming |
| `Welcome` | `OnboardingScreen` | Legacy naming |
| `EventsList` | `EventsListScreen` | Legacy naming |
| `AddPaymentMethod` | `AddPaymentScreen` | Legacy naming |
| `HomeScreen` | `HomeScreen` | Duplicate name used in some navigate() calls |
| `Help` | `HelpCenterScreen` | Shortened name |

## Shared Components Used Across Screens

| Component | File | Used By |
|-----------|------|---------|
| `ScreenHeader` | `components/ScreenHeader.tsx` | All non-tab screens (back button + title) |
| `PrimaryButton` | `components/PrimaryButton.tsx` | All screens with CTAs |
| `Avatar` | `components/Avatar.tsx` | Contact lists, profile, gift cards |

## Screen Count Summary

| Flow | Count |
|------|-------|
| Onboarding | 7 |
| Main Tabs | 5 |
| Gifting | 13 |
| Events | 2 |
| Finance | 2 |
| Settings | 11 |
| Legal | 2 |
| **Total unique screens** | **41** |
| Aliases | 6 |
| **Total registered routes** | **47** |
