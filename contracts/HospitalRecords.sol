// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Menyimpan role wallet, akses dokter ke pasien, dan hash rekam medis.
// Storage on-chain publik, jadi kontrak hanya menyimpan hash. Isi data ada di MySQL.
contract HospitalRecords {
    // Tipe data

    enum Role { None, Admin, Doctor, Patient }

    struct MedicalRecord {
        uint256 id;
        address patient;
        address doctor;
        bytes32 dataHash;   // hash isi rekam medis
        uint64 createdAt;
        uint64 updatedAt;
        bool isDeleted;     // soft delete
    }

    // Storage

    uint64 public constant MAX_ACCESS_DURATION = 60 days;

    address public immutable admin;

    mapping(address => Role) private roles;

    // Id rekam medis mulai dari 1.
    uint256 private lastRecordId;
    uint256 private activeRecordCount;
    mapping(uint256 => MedicalRecord) private records;
    mapping(address => uint256[]) private patientRecords;

    // Akses dokter ke pasien beserta epoch saat akses diberikan.
    struct CareAccess {
        uint64 expiresAt;
        uint64 doctorEpoch;
        uint64 patientEpoch;
    }

    // careAccess[pasien][dokter]. expiresAt 0 = tidak ada akses.
    mapping(address patient => mapping(address doctor => CareAccess)) private careAccess;

    // Naik saat role Doctor dicabut, sehingga akses lama dokter itu mati.
    mapping(address doctor => uint64) private doctorEpoch;

    // Naik saat role Patient dicabut, sehingga akses lama pasien itu mati.
    mapping(address patient => uint64) private patientEpoch;

    // Event

    event RoleGranted(address indexed account, Role role, address indexed admin);
    event RoleRevoked(address indexed account, Role previousRole, address indexed admin);
    event PatientRegistered(address indexed patient);
    event RecordAdded(uint256 indexed id, address indexed patient, address indexed doctor, bytes32 dataHash);
    event RecordUpdated(uint256 indexed id, address indexed patient, address indexed doctor, bytes32 oldHash, bytes32 newHash);
    event RecordDeleted(uint256 indexed id, address indexed patient, address indexed doctor);
    event AccessGranted(address indexed patient, address indexed doctor, uint64 expiresAt);
    event AccessExtended(address indexed patient, address indexed doctor, uint64 oldExpiresAt, uint64 newExpiresAt);
    // Akses dicabut oleh pasien, Admin, atau dokter itu sendiri.
    event AccessRevoked(address indexed patient, address indexed doctor, address indexed by);

    // Error

    error NotAdmin();
    error NotDoctor();
    error NotAuthorized();                          // tidak boleh membaca rekam medis
    error ZeroAddress();
    error InvalidRole(Role role);                   // grantRole hanya untuk Doctor
    error AlreadyHasRole(address account, Role role);
    error NoRole(address account);
    error CannotRevokeAdmin();
    error NotPatient(address account);
    error RecordNotFound(uint256 id);
    error RecordAlreadyDeleted(uint256 id);
    error NotRecordOwner(uint256 id);
    error ZeroHash();
    error SameHash();
    error NoAccess(address patient, address doctor);              // akses tidak ada / dicabut
    error AccessExpired(address patient, address doctor, uint64 expiresAt); // akses kedaluwarsa
    error InvalidExpiry(uint64 expiresAt);                        // di luar batas 60 hari
    error AccessNotExtended(uint64 currentExpiresAt, uint64 requestedExpiresAt); // hanya boleh diperpanjang
    error NotPatientOrAdmin();                                    // hanya pasien itu atau Admin

    // Modifier

    modifier onlyAdmin() {
        if (roles[msg.sender] != Role.Admin) revert NotAdmin();
        _;
    }

    modifier onlyDoctor() {
        if (roles[msg.sender] != Role.Doctor) revert NotDoctor();
        _;
    }

    // Deployer menjadi satu-satunya Admin.
    constructor() {
        admin = msg.sender;
        roles[msg.sender] = Role.Admin;
        emit RoleGranted(msg.sender, Role.Admin, msg.sender);
    }

    // Role

    // Admin memberi role Doctor ke wallet tanpa role.
    function grantRole(address account, Role role) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (role != Role.Doctor) revert InvalidRole(role);
        if (roles[account] != Role.None) revert AlreadyHasRole(account, roles[account]);

        roles[account] = role;
        emit RoleGranted(account, role, msg.sender);
    }

    // Admin mencabut role Doctor atau Patient; semua akses wallet itu ikut mati.
    function revokeRole(address account) external onlyAdmin {
        Role previous = roles[account];
        if (previous == Role.Admin) revert CannotRevokeAdmin();
        if (previous == Role.None) revert NoRole(account);

        roles[account] = Role.None;
        if (previous == Role.Doctor) doctorEpoch[account]++;
        else patientEpoch[account]++; // previous == Patient
        emit RoleRevoked(account, previous, msg.sender);
    }

    function registerAsPatient() external {
        if (roles[msg.sender] != Role.None) revert AlreadyHasRole(msg.sender, roles[msg.sender]);

        roles[msg.sender] = Role.Patient;
        emit PatientRegistered(msg.sender);
    }

    function getRole(address account) external view returns (Role) {
        return roles[account];
    }

    // Akses dokter ke pasien

    // Pasien memberi atau memperpanjang akses dokter.
    function grantDoctorAccess(address doctor, uint64 expiresAt) external {
        if (roles[msg.sender] != Role.Patient) revert NotPatient(msg.sender);
        if (roles[doctor] != Role.Doctor) revert NotDoctor();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_ACCESS_DURATION) {
            revert InvalidExpiry(expiresAt);
        }

        uint64 current = _expiry(msg.sender, doctor);
        bool stillActive = current >= block.timestamp;
        // Akses aktif hanya boleh diperpanjang.
        if (stillActive && expiresAt <= current) revert AccessNotExtended(current, expiresAt);

        careAccess[msg.sender][doctor] = CareAccess({
            expiresAt: expiresAt, doctorEpoch: doctorEpoch[doctor], patientEpoch: patientEpoch[msg.sender]
        });
        if (stillActive) {
            emit AccessExtended(msg.sender, doctor, current, expiresAt);
        } else {
            emit AccessGranted(msg.sender, doctor, expiresAt);
        }
    }

    // Pasien atau Admin mencabut akses dokter yang masih aktif.
    function revokeDoctorAccess(address patient, address doctor) external {
        if (msg.sender != patient && roles[msg.sender] != Role.Admin) revert NotPatientOrAdmin();
        _requireActiveAccess(patient, doctor);

        delete careAccess[patient][doctor];
        emit AccessRevoked(patient, doctor, msg.sender);
    }

    // Dokter melepas sendiri aksesnya ke pasien.
    function renounceAccess(address patient) external onlyDoctor {
        _requireActiveAccess(patient, msg.sender);

        delete careAccess[patient][msg.sender];
        emit AccessRevoked(patient, msg.sender, msg.sender);
    }

    function hasAccess(address patient, address doctor) external view returns (bool) {
        return _expiry(patient, doctor) >= block.timestamp;
    }

    // Waktu kedaluwarsa akses. 0 = tidak ada akses.
    function getAccessExpiry(address patient, address doctor) external view returns (uint64) {
        return _expiry(patient, doctor);
    }

    // Rekam medis: tulis

    // Dokter dengan akses aktif menambah rekam medis pasien.
    function addRecord(address patient, bytes32 dataHash) external onlyDoctor returns (uint256 id) {
        if (roles[patient] != Role.Patient) revert NotPatient(patient);
        _requireActiveAccess(patient, msg.sender);
        if (dataHash == bytes32(0)) revert ZeroHash();

        id = ++lastRecordId;
        uint64 nowTs = uint64(block.timestamp);
        records[id] = MedicalRecord({
            id: id,
            patient: patient,
            doctor: msg.sender,
            dataHash: dataHash,
            createdAt: nowTs,
            updatedAt: nowTs,
            isDeleted: false
        });
        patientRecords[patient].push(id);
        activeRecordCount++;

        emit RecordAdded(id, patient, msg.sender, dataHash);
    }

    // Dokter pembuat mengganti hash rekam medis.
    function updateRecord(uint256 id, bytes32 newHash) external onlyDoctor {
        MedicalRecord storage r = _ownedActiveRecord(id);
        if (newHash == bytes32(0)) revert ZeroHash();
        if (newHash == r.dataHash) revert SameHash();

        bytes32 oldHash = r.dataHash;
        r.dataHash = newHash;
        r.updatedAt = uint64(block.timestamp);

        emit RecordUpdated(id, r.patient, msg.sender, oldHash, newHash);
    }

    function deleteRecord(uint256 id) external onlyDoctor {
        MedicalRecord storage r = _ownedActiveRecord(id);

        r.isDeleted = true;
        r.updatedAt = uint64(block.timestamp);
        activeRecordCount--;

        emit RecordDeleted(id, r.patient, msg.sender);
    }

    // Rekam medis: baca (dokter dengan akses aktif atau pasien pemilik)

    function getRecord(uint256 id) external view returns (MedicalRecord memory) {
        return _readableRecord(id);
    }

    function getRecordIdsByPatient(address patient) external view returns (uint256[] memory ids) {
        _requireCanRead(patient);

        uint256[] storage all = patientRecords[patient];
        uint256 count;
        for (uint256 i = 0; i < all.length; i++) {
            if (!records[all[i]].isDeleted) count++;
        }
        ids = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < all.length; i++) {
            if (!records[all[i]].isDeleted) ids[j++] = all[i];
        }
    }

    // Mencocokkan hash dari database dengan hash di kontrak.
    function verifyRecord(uint256 id, bytes32 hash) external view returns (bool) {
        return _readableRecord(id).dataHash == hash;
    }

    function getStats() external view returns (uint256 activeRecords) {
        return activeRecordCount;
    }

    // Helper internal

    // Revert jika akses dokter ke pasien tidak ada atau kedaluwarsa.
    function _requireActiveAccess(address patient, address doctor) private view {
        uint64 expiresAt = _expiry(patient, doctor);
        if (expiresAt == 0) revert NoAccess(patient, doctor);
        if (expiresAt < block.timestamp) revert AccessExpired(patient, doctor, expiresAt);
    }

    // expiresAt yang masih sah; 0 jika role atau epoch tidak cocok.
    function _expiry(address patient, address doctor) private view returns (uint64) {
        if (roles[patient] != Role.Patient || roles[doctor] != Role.Doctor) return 0;
        CareAccess storage a = careAccess[patient][doctor];
        if (a.doctorEpoch != doctorEpoch[doctor] || a.patientEpoch != patientEpoch[patient]) return 0;
        return a.expiresAt;
    }

    // Rekam medis aktif milik dokter pemanggil, dengan akses yang masih aktif.
    function _ownedActiveRecord(uint256 id) private view returns (MedicalRecord storage r) {
        r = _activeRecord(id);
        if (r.doctor != msg.sender) revert NotRecordOwner(id);
        if (roles[r.patient] != Role.Patient) revert NotPatient(r.patient);
        _requireActiveAccess(r.patient, msg.sender);
    }

    function _activeRecord(uint256 id) private view returns (MedicalRecord storage r) {
        if (id == 0 || id > lastRecordId) revert RecordNotFound(id);
        r = records[id];
        if (r.isDeleted) revert RecordAlreadyDeleted(id);
    }

    function _readableRecord(uint256 id) private view returns (MedicalRecord storage r) {
        r = _activeRecord(id);
        _requireCanRead(r.patient);
    }

    // Dokter dengan akses aktif atau pasien pemilik; selain itu ditolak.
    function _requireCanRead(address patient) private view {
        Role role = roles[msg.sender];
        if (role == Role.Doctor) {
            _requireActiveAccess(patient, msg.sender);
            return;
        }
        if (role == Role.Patient && msg.sender == patient) return;
        revert NotAuthorized();
    }
}
